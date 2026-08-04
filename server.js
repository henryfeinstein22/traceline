const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  if (!fs.existsSync(DB_FILE)) return { families: [], kids: [], conversations: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { families: [], kids: [], conversations: [] };
  }
}

function writeDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function hash(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

function newId(prefix) {
  return prefix + Date.now() + Math.floor(Math.random() * 1000);
}

// --- Safety filtering: MVP rule-based check only. -----------------------
// This is a placeholder, not production-grade moderation. A real launch
// needs a real moderation API (OpenAI moderation endpoint, Perspective API,
// or similar) in front of both the kid's messages and the AI's responses.
const FLAG_PATTERNS = [
  { re: /\b(kill myself|suicide|want to die|hurt myself|self.?harm)\b/i, reason: 'possible self-harm language' },
  { re: /\b(my address is|my phone number is|my password is|meet me at)\b/i, reason: 'possible personal info sharing' },
  { re: /\b(gun|weapon|bomb)\b.{0,30}\b(how to|make|build)\b/i, reason: 'possible dangerous request' },
];

function checkSafety(text) {
  for (const p of FLAG_PATTERNS) {
    if (p.re.test(text)) return { flagged: true, reason: p.reason };
  }
  return { flagged: false, reason: null };
}

// --- Stub AI: used only when no ANTHROPIC_API_KEY is configured. --------
function stubAIResponse(userText, homeworkMode) {
  const t = userText.toLowerCase();
  if (homeworkMode) {
    return `[demo AI] Here's a starting point for your assignment: break "${userText.slice(0, 60)}" into 3 parts - what you already know, what you need to find out, and how you'll explain it in your own words. What's the first part you want to work on?`;
  }
  if (t.includes('?')) {
    return `[demo AI] Good question. In a real deployment this would call a real AI model — for now: what do you already think the answer might be?`;
  }
  return `[demo AI] Got it — tell me more about what you're working on.`;
}

// --- Age-banded AI literacy: the core teaching layer, not just safety. ---
function ageBand(age) {
  if (!age) return 'middle';
  if (age <= 10) return 'elementary';
  if (age <= 13) return 'middle';
  return 'high';
}

const SYSTEM_PROMPTS = {
  elementary: {
    homework: `You are the AI helper inside Traceline, talking to a young elementary school kid (roughly ages 6-10). Use very simple words and short sentences (1-2 sentences per turn). Act like a friendly guide: ask one simple question at a time to help them think, don't just give answers. Use fun comparisons to things kids know (animals, toys, food). Never produce anything that wouldn't be appropriate for a young child.`,
    general: `You are the AI helper inside Traceline, chatting with a young elementary school kid (roughly ages 6-10). Use very simple, warm, short sentences. Be encouraging and curious. Never produce anything that wouldn't be appropriate for a young child. If they ask about something risky or grown-up, gently suggest they ask a parent.`,
  },
  middle: {
    homework: `You are the AI assistant inside Traceline, a homework-help chat for a middle-school-age student (roughly 11-13). Act as a Socratic tutor: help them think it through step by step rather than handing over answers. Keep responses concise (2-4 sentences), age-appropriate, and encouraging. Never produce content that wouldn't be appropriate in a school setting.`,
    general: `You are the AI assistant inside Traceline, a safe chat app for a middle-school-age student (roughly 11-13). Be warm, concise (2-4 sentences), and age-appropriate. Never produce content that wouldn't be appropriate for a child. If asked about something risky, gently suggest they talk to a parent or trusted adult.`,
  },
  high: {
    homework: `You are the AI assistant inside Traceline, a homework-help chat for a school-age kid. Act as a Socratic tutor: help the student think it through, don't just hand them the answer. Break problems into smaller steps, ask guiding questions, and only give a direct answer if they're clearly stuck after trying. Keep responses short (2-4 sentences), age-appropriate, and encouraging. Never produce content that wouldn't be appropriate in a school setting.`,
    general: `You are the AI assistant inside Traceline, a safe chat app for a school-age kid. Be warm, concise (2-4 sentences), and age-appropriate. Never produce content that wouldn't be appropriate for a child: no violence, no sexual content, no instructions for anything dangerous. If asked about something risky or something an adult should know about, gently suggest they talk to a parent or trusted adult.`,
  },
};

// Periodic teaching moments — this is what makes Traceline "teach AI literacy"
// rather than just supervise. Shown every few kid messages, never repeated
// within the same conversation.
const LITERACY_TIPS = {
  elementary: [
    "Did you know? I'm a computer program, not a real person — I don't have feelings, but I try to be helpful!",
    "I can make mistakes sometimes, just like anyone learning something new. It's smart to check big facts with a grown-up or a book.",
    "Asking clear questions helps me give better answers — try telling me exactly what you want to know!",
    "I don't remember you between chats unless someone shows me — that's different from how people remember things.",
  ],
  middle: [
    "AI tip: I generate answers by predicting likely-helpful text, not by \"knowing\" facts the way a search engine looks them up — so it's always worth double-checking anything important.",
    "AI tip: the more specific your question, the more useful my answer will be. Compare \"tell me about history\" to \"what caused World War 1 to start\" — which do you think gets a better answer?",
    "AI tip: I can sound confident even when I'm wrong — that's called a \"hallucination.\" Always verify facts that matter with a trusted source.",
    "AI tip: using me to help you think through a problem builds your skills more than just asking for the final answer.",
  ],
  high: [
    "AI tip: I predict text based on patterns in training data — that's different from reasoning the way a person does, even when the output looks similar.",
    "AI tip: I can be confidently wrong (a \"hallucination\"). For anything that matters — a grade, a fact in an essay, a decision — verify with a primary source.",
    "AI tip: how you prompt me changes the answer a lot. Specific, well-scoped questions get better results than vague ones.",
  ],
};

function maybeGetLiteracyTip(convo, band) {
  const kidMsgCount = convo.messages.filter(m => m.role === 'kid').length;
  if (kidMsgCount === 0 || kidMsgCount % 4 !== 0) return null;
  const shown = convo.shownTips || [];
  const pool = LITERACY_TIPS[band] || LITERACY_TIPS.middle;
  const available = pool.filter(t => !shown.includes(t));
  if (available.length === 0) return null;
  return available[0];
}

async function getAIResponse(userText, homeworkMode, priorMessages, band) {
  const prompts = SYSTEM_PROMPTS[band] || SYSTEM_PROMPTS.middle;
  const system = homeworkMode ? prompts.homework : prompts.general;
  if (!anthropic) return stubAIResponse(userText, homeworkMode);

  const history = priorMessages.filter(m => m.role !== 'tip').slice(-10).map(m => ({
    role: m.role === 'kid' ? 'user' : 'assistant',
    content: m.content,
  }));

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system,
      messages: [...history, { role: 'user', content: userText }],
    });
    const text = resp.content.find(b => b.type === 'text');
    return text ? text.text : "Sorry, I couldn't come up with a response — try asking again.";
  } catch (e) {
    console.error('Anthropic API error:', e.message);
    return "I'm having trouble responding right now — try again in a moment.";
  }
}

// --- Family + kid accounts -------------------------------------------------
app.post('/api/family', (req, res) => {
  const { familyName, passphrase } = req.body || {};
  if (!familyName || !passphrase) return res.status(400).json({ error: 'familyName and passphrase required' });
  const db = readDB();
  const family = { id: newId('fam'), familyName, passHash: hash(passphrase), createdAt: Date.now() };
  db.families.push(family);
  writeDB(db);
  res.json({ id: family.id, familyName: family.familyName });
});

// Kids look up their family by name only, no passphrase (parents hold the
// passphrase; kids just need to find their profile to start chatting).
app.get('/api/family/by-name/:familyName', (req, res) => {
  const db = readDB();
  const family = db.families.find(f => f.familyName.toLowerCase() === req.params.familyName.toLowerCase());
  if (!family) return res.status(404).json({ error: 'family not found' });
  res.json({ id: family.id, familyName: family.familyName });
});

app.post('/api/family/login', (req, res) => {
  const { familyName, passphrase } = req.body || {};
  const db = readDB();
  const family = db.families.find(f => f.familyName === familyName && f.passHash === hash(passphrase || ''));
  if (!family) return res.status(401).json({ error: 'invalid family name or passphrase' });
  res.json({ id: family.id, familyName: family.familyName });
});

app.post('/api/family/:familyId/kids', (req, res) => {
  const { name, age, consentGiven } = req.body || {};
  if (!name || !consentGiven) return res.status(400).json({ error: 'name and parental consent are required' });
  const db = readDB();
  const family = db.families.find(f => f.id === req.params.familyId);
  if (!family) return res.status(404).json({ error: 'family not found' });
  const kid = {
    id: newId('kid'),
    familyId: family.id,
    name,
    age: Number(age) || null,
    consentAt: Date.now(),
    createdAt: Date.now(),
  };
  db.kids.push(kid);
  writeDB(db);
  res.json(kid);
});

app.get('/api/family/:familyId/kids', (req, res) => {
  const db = readDB();
  res.json(db.kids.filter(k => k.familyId === req.params.familyId));
});

// --- Conversations / messages ----------------------------------------------
app.post('/api/kids/:kidId/conversations', (req, res) => {
  const { title, homeworkMode } = req.body || {};
  const db = readDB();
  const kid = db.kids.find(k => k.id === req.params.kidId);
  if (!kid) return res.status(404).json({ error: 'kid not found' });
  const convo = {
    id: newId('conv'),
    kidId: kid.id,
    title: title || 'New chat',
    homeworkMode: !!homeworkMode,
    createdAt: Date.now(),
    messages: [],
  };
  db.conversations.push(convo);
  writeDB(db);
  res.json(convo);
});

app.get('/api/kids/:kidId/conversations', (req, res) => {
  const db = readDB();
  res.json(db.conversations.filter(c => c.kidId === req.params.kidId).sort((a, b) => b.createdAt - a.createdAt));
});

app.get('/api/conversations/:id', (req, res) => {
  const db = readDB();
  const convo = db.conversations.find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: 'not found' });
  res.json(convo);
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const db = readDB();
  const convo = db.conversations.find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: 'not found' });
  const kid = db.kids.find(k => k.id === convo.kidId);
  const band = ageBand(kid ? kid.age : null);

  const userSafety = checkSafety(text);
  const userMsg = { role: 'kid', content: text, ts: Date.now(), flagged: userSafety.flagged, flagReason: userSafety.reason };
  convo.messages.push(userMsg);

  const aiText = await getAIResponse(text, convo.homeworkMode, convo.messages, band);
  const aiSafety = checkSafety(aiText);
  const aiMsg = { role: 'assistant', content: aiText, ts: Date.now(), flagged: aiSafety.flagged, flagReason: aiSafety.reason };
  convo.messages.push(aiMsg);

  let tipMsg = null;
  const tipText = maybeGetLiteracyTip(convo, band);
  if (tipText) {
    tipMsg = { role: 'tip', content: tipText, ts: Date.now(), flagged: false, flagReason: null };
    convo.messages.push(tipMsg);
    convo.shownTips = [...(convo.shownTips || []), tipText];
  }

  writeDB(db);
  res.json({ userMsg, aiMsg, tipMsg });
});

// --- Parent-facing rollup: all conversations + flags across a family's kids
app.get('/api/family/:familyId/overview', (req, res) => {
  const db = readDB();
  const kids = db.kids.filter(k => k.familyId === req.params.familyId);
  const kidIds = new Set(kids.map(k => k.id));
  const conversations = db.conversations.filter(c => kidIds.has(c.kidId));
  const flaggedCount = conversations.reduce((sum, c) => sum + c.messages.filter(m => m.flagged).length, 0);
  const messageCount = conversations.reduce((sum, c) => sum + c.messages.length, 0);
  res.json({ kids, conversations, flaggedCount, messageCount });
});

app.listen(PORT, () => {
  console.log(`Traceline running at http://localhost:${PORT}`);
});
