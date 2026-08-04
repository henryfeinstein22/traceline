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

// Self-hosted visit counter — no third-party analytics, no cookies, just a
// count of homepage loads, so there's a real (if rough) signal for whether
// anyone besides the person building this is actually looking at it.
app.get('/', (req, res, next) => {
  const db = readDB();
  db.visits = (db.visits || 0) + 1;
  writeDB(db);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  const empty = { families: [], kids: [], conversations: [], classrooms: [], interest: [], visits: 0 };
  if (!fs.existsSync(DB_FILE)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...empty, ...data };
  } catch (e) {
    return empty;
  }
}

function writeDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function hash(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

// IDs double as the only access control on lookups like GET /api/conversations/:id
// (no auth on that route) — they must be unguessable, not just unique. A
// timestamp + 3-digit-random suffix is brute-forceable within a known time
// window, which would let someone with a rough idea of when a conversation
// was created enumerate its ID and read flagged content (self-harm language,
// personal info) meant only for that family.
function newId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

// --- Safety filtering: two independent layers, both applied to both the ---
// kid's message and the AI's response. checkSafety() is instant regex,
// classifySafety() below is a dedicated Claude classification pass. Neither
// replaces a dedicated moderation API (OpenAI moderation endpoint, Perspective
// API) at real scale, but this is a real second layer, not just a keyword list.
const FLAG_PATTERNS = [
  { re: /\b(kill myself|suicide|want to die|don'?t want to (be alive|live|be here)|not want to (be alive|live|be here)|hurt myself|self.?harm|end it all|better off dead|no reason to live|no point (in living|living))\b/i, reason: 'possible self-harm language' },
  { re: /\b(my address is|my phone number is|my password is|meet me at)\b/i, reason: 'possible personal info sharing' },
  { re: /\b(gun|weapon|bomb)\b.{0,30}\b(how to|make|build)\b/i, reason: 'possible dangerous request' },
];

// A regex over the AI's own response ("trusted adult", "talk to a parent")
// used to be the second layer here, on the theory that the model surfaces
// crisis language in context better than a keyword list can. Retired after
// a 219-thread batch test: every one of the routine AI-literacy responses
// this system prompt encourages ("if unsure, talk to a trusted adult") was
// getting falsely flagged, because that phrase means the same thing whether
// the AI is redirecting a real crisis or answering "can I trust you?" — a
// plain regex can't tell those apart. classifySafety() below replaces this:
// it reads the actual AI response for real risk, not just matching phrases.

function checkSafety(text) {
  for (const p of FLAG_PATTERNS) {
    if (p.re.test(text)) return { flagged: true, reason: p.reason };
  }
  return { flagged: false, reason: null };
}

// Second, independent detection layer: a dedicated Claude classification pass,
// separate from the chat model's own reply. Regex alone always misses real
// phrasings; this catches indirect/misspelled/context-dependent risk that a
// keyword list structurally can't. Runs alongside checkSafety() rather than
// replacing it — if the API errors, checkSafety's regex is still the floor.
async function classifySafety(text) {
  if (!anthropic) return { flagged: false, reason: null };
  const system = `You are a safety classifier for messages inside a kids' AI chat app (ages roughly 6-17). Classify the given message for real risk signals: self-harm or suicidal language (even indirect, misspelled, or euphemistic), sharing of personal identifying information (home address, phone number, password, a plan to meet someone), or a request for instructions to make or use a weapon/dangerous device. Do NOT flag normal age-appropriate conversation, schoolwork, or clearly fictional/hypothetical discussion (e.g. a book report on a war, a video game question). Respond with ONLY a JSON object and nothing else: {"flagged": boolean, "category": "self_harm" | "personal_info" | "dangerous_content" | "none", "reason": "short reason, empty string if not flagged"}`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    });
    const block = resp.content.find(b => b.type === 'text');
    // Claude sometimes wraps the JSON in a ```json fence despite being told
    // not to — strip it before parsing rather than let that fail silently
    // into flagged:false, which would defeat this entire safety layer.
    const raw = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(raw);
    return {
      flagged: !!parsed.flagged,
      reason: parsed.flagged ? (parsed.reason || parsed.category || 'flagged by safety classifier') : null,
    };
  } catch (e) {
    console.error('Safety classifier error:', e.message);
    return { flagged: false, reason: null };
  }
}

// --- Stub AI: used only when no ANTHROPIC_API_KEY is configured. --------
function stubAIResponse(userText, mode) {
  const t = userText.toLowerCase();
  if (mode === 'homework') {
    return `[demo AI] Here's a starting point for your assignment: break "${userText.slice(0, 60)}" into 3 parts - what you already know, what you need to find out, and how you'll explain it in your own words. What's the first part you want to work on?`;
  }
  if (mode === 'decision') {
    return `[demo AI] Let's think it through together: what matters most to you here, and what are the couple of options you're weighing?`;
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
    homework: `You are the AI helper inside Traceline, talking to a young elementary school kid (roughly ages 6-10). Use very simple words and short sentences (1-2 sentences per turn). Act like a friendly guide: ask one simple question at a time to help them think, don't just give answers. Use fun comparisons to things kids know (animals, toys, food). Celebrate their ideas ("Nice thinking!") before asking the next question. Never produce anything that wouldn't be appropriate for a young child.`,
    general: `You are the AI helper inside Traceline, chatting with a young elementary school kid (roughly ages 6-10). Use very simple, warm, short sentences. Be genuinely curious about what they're into, and ask a fun follow-up question when it fits naturally. Never produce anything that wouldn't be appropriate for a young child. If they ask about something risky or grown-up, gently suggest they ask a parent.`,
    decision: `You are the AI helper inside Traceline, helping a young elementary school kid (roughly ages 6-10) think through an everyday choice or routine — like what to do first, how to organize their backpack, or picking between two fun options. Ask simple questions about what they want and why. Offer a couple of simple options in plain words, but always let THEM make the final choice — never decide for them. For anything big or about safety, gently say a grown-up should help. Keep it playful and short.`,
  },
  middle: {
    homework: `You are the AI assistant inside Traceline, a homework-help chat for a middle-school-age student (roughly 11-13). Act as a Socratic tutor: help them think it through step by step rather than handing over answers. Keep responses concise (2-4 sentences), age-appropriate, and encouraging. Never produce content that wouldn't be appropriate in a school setting.`,
    general: `You are the AI assistant inside Traceline, a safe chat app for a middle-school-age student (roughly 11-13). Be warm, concise (2-4 sentences), and age-appropriate — genuinely curious about what they're interested in, with a natural follow-up question when it fits. Never produce content that wouldn't be appropriate for a child. If asked about something risky, gently suggest they talk to a parent or trusted adult.`,
    decision: `You are the AI assistant inside Traceline, helping a middle-school-age student (roughly 11-13) think through an everyday decision or plan a routine — like managing homework time, picking an activity, or organizing a task. Act as a thinking partner: ask what matters most to them, lay out the tradeoffs of a couple options, and encourage them to make the final call themselves — you're here to help them think clearly, not to decide for them. Keep responses concise (2-4 sentences) and encouraging. If the decision involves something risky or something a parent should weigh in on, say so.`,
  },
  high: {
    homework: `You are the AI assistant inside Traceline, a homework-help chat for a school-age kid. Act as a Socratic tutor: help the student think it through, don't just hand them the answer. Break problems into smaller steps, ask guiding questions, and only give a direct answer if they're clearly stuck after trying. Keep responses short (2-4 sentences), age-appropriate, and encouraging. Never produce content that wouldn't be appropriate in a school setting.`,
    general: `You are the AI assistant inside Traceline, a safe chat app for a school-age kid. Be warm, concise (2-4 sentences), and age-appropriate — genuinely curious, with a natural follow-up question when it fits. Never produce content that wouldn't be appropriate for a child: no violence, no sexual content, no instructions for anything dangerous. If asked about something risky or something an adult should know about, gently suggest they talk to a parent or trusted adult.`,
    decision: `You are the AI assistant inside Traceline, helping a school-age student think through a decision or plan a routine — like time management, choosing between commitments, or organizing a task. Be a thinking partner: ask clarifying questions, lay out real tradeoffs, and let them reach their own conclusion — the goal is building their decision-making skill, not replacing it. Keep responses concise (2-4 sentences). Flag when something is big enough that a parent or trusted adult should be involved.`,
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
    "If I help you pick something, remember — YOU are the one who knows what you like best!",
    "Try this: ask me the same question again but in different words. If I say something different, that's your cue to check with a grown-up or a book!",
  ],
  middle: [
    "AI tip: I generate answers by predicting likely-helpful text, not by \"knowing\" facts the way a search engine looks them up — so it's always worth double-checking anything important.",
    "AI tip: the more specific your question, the more useful my answer will be. Compare \"tell me about history\" to \"what caused World War 1 to start\" — which do you think gets a better answer?",
    "AI tip: I can sound confident even when I'm wrong — that's called a \"hallucination.\" Always verify facts that matter with a trusted source.",
    "AI tip: using me to help you think through a problem builds your skills more than just asking for the final answer.",
    "AI tip: I can help you weigh options, but I don't know things about your life that matter — like how tired you are or what you promised a friend. You make the call.",
    "AI tip: try tapping \"How do you know that?\" under one of my answers — asking me to explain my reasoning, or checking with a teacher, librarian, or trusted expert (not just another AI), catches mistakes a lot better than just trusting the first answer.",
    "AI tip: if I'm helping you think through spending money — like whether to buy something now and pay for it later in parts — remember I don't know your actual budget or what else you're saving for. That's worth checking with a parent before deciding.",
  ],
  high: [
    "AI tip: I predict text based on patterns in training data — that's different from reasoning the way a person does, even when the output looks similar.",
    "AI tip: I can be confidently wrong (a \"hallucination\"). For anything that matters — a grade, a fact in an essay, a decision — verify with a primary source.",
    "AI tip: how you prompt me changes the answer a lot. Specific, well-scoped questions get better results than vague ones.",
    "AI tip: using AI to think through a decision is different from using AI to make the decision for you. The habit of deciding for yourself is a skill worth keeping.",
    "AI tip: \"buy now, pay later\" and similar options can make a purchase feel smaller than it actually is by splitting it up. If I'm helping you weigh a purchase, ask what the real total cost is before deciding.",
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

async function getAIResponse(userText, mode, priorMessages, band) {
  const prompts = SYSTEM_PROMPTS[band] || SYSTEM_PROMPTS.middle;
  const system = prompts[mode] || prompts.general;
  if (!anthropic) return stubAIResponse(userText, mode);

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

// --- Interest signups: a lower-friction option than setting up a full ------
// family, for someone just checking the site out. Also the simplest real
// signal for whether anyone besides the person building this wants it.
app.post('/api/interest', (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }
  const db = readDB();
  db.interest = db.interest || [];
  if (!db.interest.some(i => i.email.toLowerCase() === email.toLowerCase())) {
    db.interest.push({ email, ts: Date.now() });
    writeDB(db);
  }
  res.json({ ok: true });
});

// Rough usage signal, not a real admin panel — this app has no auth anywhere.
app.get('/api/stats', (req, res) => {
  const db = readDB();
  res.json({ visits: db.visits || 0, interestSignups: (db.interest || []).length });
});

// --- Real-time parent alerts -------------------------------------------
// Two channels: (1) in-app — the parent dashboard polls /alerts and shows a
// banner for anything flagged since alertsSeenAt, works today with no setup;
// (2) email — fires immediately via Resend's HTTP API when RESEND_API_KEY is
// set (resend.com has a free tier and needs no domain verification to send
// from onboarding@resend.dev while testing). No-ops cleanly if unconfigured.
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://traceline-production-fd76.up.railway.app';

async function sendParentAlertEmail(family, kid, message) {
  if (!process.env.RESEND_API_KEY || !family.email) return;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || 'Traceline <onboarding@resend.dev>',
        to: family.email,
        subject: `Traceline: a message from ${kid ? kid.name : 'your kid'} was flagged`,
        text: `A message in ${kid ? kid.name + "'s" : "your kid's"} Traceline chat was just flagged: "${message.flagReason}".\n\nView it now: ${PUBLIC_URL}/parent.html`,
      }),
    });
    if (!resp.ok) console.error('Email alert failed:', resp.status, await resp.text().catch(() => ''));
  } catch (e) {
    console.error('Email alert error:', e.message);
  }
}

app.get('/api/family/:familyId/alerts', (req, res) => {
  const db = readDB();
  const family = db.families.find(f => f.id === req.params.familyId);
  if (!family) return res.status(404).json({ error: 'family not found' });
  const kids = db.kids.filter(k => k.familyId === family.id);
  const kidById = Object.fromEntries(kids.map(k => [k.id, k]));
  const convos = db.conversations.filter(c => kidById[c.kidId]);
  const alerts = [];
  convos.forEach(c => {
    c.messages.forEach(m => {
      if (m.flagged && m.ts > (family.alertsSeenAt || 0)) {
        alerts.push({ kidName: kidById[c.kidId].name, conversationId: c.id, conversationTitle: c.title, role: m.role, reason: m.flagReason, ts: m.ts });
      }
    });
  });
  alerts.sort((a, b) => b.ts - a.ts);
  res.json({ alerts, emailAddress: family.email || null, emailAlertingConfigured: !!process.env.RESEND_API_KEY });
});

app.post('/api/family/:familyId/alerts/seen', (req, res) => {
  const db = readDB();
  const family = db.families.find(f => f.id === req.params.familyId);
  if (!family) return res.status(404).json({ error: 'family not found' });
  family.alertsSeenAt = Date.now();
  writeDB(db);
  res.json({ ok: true });
});

// --- Family + kid accounts -------------------------------------------------
app.post('/api/family', (req, res) => {
  const { familyName, passphrase, email } = req.body || {};
  if (!familyName || !passphrase) return res.status(400).json({ error: 'familyName and passphrase required' });
  const db = readDB();
  if (db.families.some(f => f.familyName.toLowerCase() === familyName.toLowerCase())) {
    return res.status(409).json({ error: 'a family with that name already exists — choose another name or sign in' });
  }
  const family = { id: newId('fam'), familyName, passHash: hash(passphrase), email: email || null, alertsSeenAt: Date.now(), createdAt: Date.now() };
  db.families.push(family);
  writeDB(db);
  res.json({ id: family.id, familyName: family.familyName, email: family.email });
});

app.post('/api/family/:familyId/email', (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'a valid email is required' });
  const db = readDB();
  const family = db.families.find(f => f.id === req.params.familyId);
  if (!family) return res.status(404).json({ error: 'family not found' });
  family.email = email;
  writeDB(db);
  res.json({ email: family.email });
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
  const family = db.families.find(f => f.familyName.toLowerCase() === (familyName || '').toLowerCase() && f.passHash === hash(passphrase || ''));
  if (!family) return res.status(401).json({ error: 'invalid family name or passphrase' });
  res.json({ id: family.id, familyName: family.familyName, email: family.email || null });
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

// --- Classrooms: opt-in, aggregate-only view for teachers. No individual --
// kid names, messages, or identifying info are ever exposed here — counts
// and rates only. A kid joins via a code a parent enters, same consent-first
// pattern as everything else in this app.
function generateClassCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/classrooms', (req, res) => {
  const { teacherName, className } = req.body || {};
  if (!teacherName || !className) return res.status(400).json({ error: 'teacherName and className are required' });
  const db = readDB();
  let code;
  do { code = generateClassCode(); } while (db.classrooms.some(c => c.code === code));
  const classroom = { id: newId('class'), teacherName, className, code, createdAt: Date.now() };
  db.classrooms.push(classroom);
  writeDB(db);
  res.json(classroom);
});

app.get('/api/classrooms/by-code/:code', (req, res) => {
  const db = readDB();
  const classroom = db.classrooms.find(c => c.code === req.params.code.toUpperCase());
  if (!classroom) return res.status(404).json({ error: 'classroom not found' });
  res.json({ id: classroom.id, className: classroom.className, teacherName: classroom.teacherName });
});

app.post('/api/kids/:kidId/join-classroom', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });
  const db = readDB();
  const kid = db.kids.find(k => k.id === req.params.kidId);
  if (!kid) return res.status(404).json({ error: 'kid not found' });
  const classroom = db.classrooms.find(c => c.code === code.toUpperCase());
  if (!classroom) return res.status(404).json({ error: 'classroom not found for that code' });
  kid.classroomId = classroom.id;
  writeDB(db);
  res.json({ joined: classroom.className });
});

app.post('/api/kids/:kidId/leave-classroom', (req, res) => {
  const db = readDB();
  const kid = db.kids.find(k => k.id === req.params.kidId);
  if (!kid) return res.status(404).json({ error: 'kid not found' });
  kid.classroomId = null;
  writeDB(db);
  res.json({ left: true });
});

app.get('/api/classrooms/:id/aggregate', (req, res) => {
  const db = readDB();
  const classroom = db.classrooms.find(c => c.id === req.params.id);
  if (!classroom) return res.status(404).json({ error: 'classroom not found' });
  const kids = db.kids.filter(k => k.classroomId === classroom.id);
  const kidIds = new Set(kids.map(k => k.id));
  const convos = db.conversations.filter(c => kidIds.has(c.kidId));
  const homeworkConvos = convos.filter(c => c.homeworkMode);
  const totalMessages = convos.reduce((s, c) => s + c.messages.length, 0);
  const flaggedMessages = convos.reduce((s, c) => s + c.messages.filter(m => m.flagged).length, 0);
  const tipsShown = convos.reduce((s, c) => s + c.messages.filter(m => m.role === 'tip').length, 0);
  res.json({
    className: classroom.className,
    teacherName: classroom.teacherName,
    code: classroom.code,
    studentCount: kids.length,
    totalConversations: convos.length,
    homeworkConversations: homeworkConvos.length,
    totalMessages,
    flaggedMessages,
    flagRate: totalMessages ? Math.round((flaggedMessages / totalMessages) * 1000) / 10 : 0,
    literacyTipsShown: tipsShown,
  });
});

// --- Conversations / messages ----------------------------------------------
const CHAT_MODES = ['general', 'homework', 'decision'];

app.post('/api/kids/:kidId/conversations', (req, res) => {
  const { title, mode } = req.body || {};
  const db = readDB();
  const kid = db.kids.find(k => k.id === req.params.kidId);
  if (!kid) return res.status(404).json({ error: 'kid not found' });
  const resolvedMode = CHAT_MODES.includes(mode) ? mode : 'general';
  const convo = {
    id: newId('conv'),
    kidId: kid.id,
    title: title || 'New chat',
    mode: resolvedMode,
    homeworkMode: resolvedMode === 'homework',
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
  const mode = convo.mode || (convo.homeworkMode ? 'homework' : 'general');

  // convo.messages here is genuinely prior turns only (this message hasn't
  // been pushed yet) — getAIResponse appends the current userText itself, so
  // pushing beforehand would send it to the model twice as consecutive turns.
  const [userClassifier, aiText] = await Promise.all([
    classifySafety(text),
    getAIResponse(text, mode, convo.messages, band),
  ]);
  const userRegex = checkSafety(text);
  const userFlagged = userRegex.flagged || userClassifier.flagged;
  const userMsg = { role: 'kid', content: text, ts: Date.now(), flagged: userFlagged, flagReason: userRegex.reason || userClassifier.reason };
  convo.messages.push(userMsg);

  const aiClassifier = await classifySafety(aiText);
  const aiRegex = checkSafety(aiText);
  if (aiClassifier.flagged && !userMsg.flagged) {
    userMsg.flagged = true;
    userMsg.flagReason = aiClassifier.reason;
  }
  const aiFlagged = aiRegex.flagged || aiClassifier.flagged;
  const aiMsg = { role: 'assistant', content: aiText, ts: Date.now(), flagged: aiFlagged, flagReason: aiRegex.reason || aiClassifier.reason };
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

  if (userMsg.flagged && kid) {
    const family = db.families.find(f => f.id === kid.familyId);
    if (family) sendParentAlertEmail(family, kid, userMsg).catch(e => console.error('alert send failed:', e.message));
  }
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

// --- Compliance report: consent records + safety-flag history, formatted
// to match what state AI-companion-for-minors laws generally require to be
// disclosable (who consented, when, what was flagged and why).
function buildComplianceReport(familyId, db) {
  const family = db.families.find(f => f.id === familyId);
  if (!family) return null;
  const kids = db.kids.filter(k => k.familyId === familyId);
  return {
    familyName: family.familyName,
    generatedAt: Date.now(),
    kids: kids.map(kid => {
      const convos = db.conversations.filter(c => c.kidId === kid.id);
      const flags = [];
      convos.forEach(c => {
        c.messages.forEach(m => {
          if (m.flagged) flags.push({ conversationTitle: c.title, role: m.role, reason: m.flagReason, ts: m.ts });
        });
      });
      return {
        name: kid.name,
        age: kid.age,
        consentAt: kid.consentAt,
        totalConversations: convos.length,
        totalMessages: convos.reduce((s, c) => s + c.messages.length, 0),
        flags,
      };
    }),
  };
}

app.get('/api/family/:familyId/compliance-report', (req, res) => {
  const db = readDB();
  const report = buildComplianceReport(req.params.familyId, db);
  if (!report) return res.status(404).json({ error: 'family not found' });
  res.json(report);
});

app.get('/api/family/:familyId/compliance-report.csv', (req, res) => {
  const db = readDB();
  const report = buildComplianceReport(req.params.familyId, db);
  if (!report) return res.status(404).json({ error: 'family not found' });

  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['kid_name', 'age', 'consent_recorded_at', 'total_conversations', 'total_messages', 'flagged_role', 'flagged_conversation', 'flag_reason', 'flagged_at']];
  report.kids.forEach(kid => {
    if (kid.flags.length === 0) {
      rows.push([kid.name, kid.age, new Date(kid.consentAt).toISOString(), kid.totalConversations, kid.totalMessages, '', '', '', '']);
    } else {
      kid.flags.forEach(f => {
        rows.push([kid.name, kid.age, new Date(kid.consentAt).toISOString(), kid.totalConversations, kid.totalMessages, f.role, f.conversationTitle, f.reason, new Date(f.ts).toISOString()]);
      });
    }
  });
  const csv = rows.map(r => r.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${report.familyName.replace(/[^a-z0-9]/gi, '_')}_compliance_report.csv"`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Traceline running at http://localhost:${PORT}`);
});
