# Traceline — Privacy Policy, Terms of Service, and Incident Response Plan

Drafted 2026-08-04. **This is a working draft, not a legal document.** Nothing here has been reviewed by a lawyer. Before any public launch beyond people you personally know, get real legal review — especially the children's-privacy (COPPA-adjacent) and mandatory-reporting sections, both of which carry real liability if wrong. Written to be honest about what the product actually does today, including its gaps — not aspirational copy.

---

## Part 1: Privacy Policy

### What we collect
- **From the parent**: family name, a passphrase (stored as a SHA-256 hash, never in plain text), optionally an email address (only used for safety alerts, never marketing).
- **From the parent, about the kid**: name, age, and the timestamp of parental consent.
- **From using the product**: every message the kid sends and every AI reply, timestamped, with safety-flag status and reasoning. Conversation titles. Which chat mode (general/homework/decision) was used. Optional classroom membership (a code only, no data shared with the teacher beyond anonymized aggregate counts).

### What we don't collect
No location data, no device fingerprinting, no third-party ad trackers, no cookies used for tracking. The homepage visit counter is a single aggregate number with no per-visitor identity attached.

### How it's used
- To generate the AI's responses (sent to Anthropic's API — see "Third parties" below).
- To run safety detection (a keyword filter plus a dedicated AI safety classifier) on every message, both the kid's and the AI's.
- To show the parent dashboard, compliance report, and provenance links.
- To send a real-time email alert to the parent if configured (see Part 3).

### Third parties
- **Anthropic** (Claude API): every message is sent to Anthropic to generate the AI's response and to run the safety classifier. Governed by Anthropic's own API terms and data-use policy — we don't control that separately.
- **Resend** (if a parent's family has email alerting configured — requires the operator to set `RESEND_API_KEY`): the parent's email address and a summary of what was flagged is sent to Resend to deliver the alert email. No other data leaves the app.
- We do not sell data. We do not use data for advertising. There are no other third parties.

### Data retention
Indefinite, by default — there is no automatic deletion. **This is a real gap, not a design choice**, and should be revisited (e.g., auto-purge conversations after N months) before real scale.

### Parent rights
- **View everything**: the parent dashboard shows every kid, every conversation, every flag.
- **Export everything**: "Export all data (JSON)" on the parent dashboard downloads the complete record for the family.
- **Delete everything**: "Delete everything" on the parent dashboard permanently removes the family, all kid profiles, and all conversations. This is irreversible and requires re-entering the account passphrase to confirm.

### Security, honestly
- Passphrases are hashed (SHA-256), not stored in plain text.
- There is **no encryption at rest** for the underlying data file — a real gap for a launch beyond trusted testing.
- There is **no session/token authentication anywhere in the app** — access to a family's data requires only knowing its passphrase (parent flows) or, for the kid-chat flow, just the family name (by design, so a kid doesn't need a password — see Part 2 for the tradeoff this implies).
- Conversation, family, and kid IDs are cryptographically random (not guessable/enumerable) — this was a real vulnerability found and fixed during testing (see repo commit history).

### Children's privacy (COPPA-adjacent)
No kid profile can be created without a parent/guardian first providing consent, which is timestamped and recorded. Kids do not create their own accounts or provide their own contact information. This is designed to be consent-first, but has **not been reviewed against COPPA or state-level AI-companion-for-minors laws (e.g., NY, VA, MI 2026 legislation)** — that review needs to happen before any public launch.

---

## Part 2: Terms of Service (brief)

- Traceline is a tool that logs and safety-checks AI conversations for parent visibility — it is **not** a substitute for professional mental health care, medical advice, or legal advice, and should not be relied on as one.
- The AI can be wrong. Responses are not guaranteed accurate, and homework/decision-mode guidance should be checked by the kid and, where it matters, a trusted adult.
- Safety flagging is **not guaranteed to catch everything** — it combines keyword matching and an AI classifier, both of which can miss things or occasionally over/under-flag. It is a real second layer over a naive approach, not a certified moderation system.
- A family's data belongs to that family. See Part 1 for export/delete rights.
- The kid-chat lookup flow (family name only, no passphrase) means **anyone who knows or guesses a family name can access that family's kid profiles and start chatting as them**. This is a deliberate tradeoff (kids shouldn't need to memorize a password) but is a real limitation parents should know about — don't use an easily-guessable family name if that matters to you.

---

## Part 3: Incident response — what happens on a real flagged disclosure

### What's automated today
1. **Detection**: every message (kid's and AI's) is checked by both a keyword filter and a dedicated AI safety classifier, tagged with a category (self-harm, personal info, dangerous content).
2. **In the moment, to the kid**: if the category is self-harm, a support message renders directly in the chat immediately — 988 (Suicide & Crisis Lifeline), Crisis Text Line (text HOME to 741741), and a note that a trusted adult will also see this. This does not block or delay the AI's own reply.
3. **To the parent**: the flag appears immediately on the parent dashboard's alert banner (polls every 20s while the dashboard is open). If the family has an email on file *and* the operator has configured `RESEND_API_KEY`, an email fires at the same time.

### The real gap
If the parent isn't looking at the dashboard and email alerting isn't configured (or the parent doesn't see the email in time), **nothing else happens automatically**. There is no SMS fallback, no escalation timer, no third-party crisis-response integration, and no mechanism to notify authorities. For real-world use beyond trusted testing, this is the single most important thing to close — options in rough order of effort: (a) get `RESEND_API_KEY` configured so email alerting is live, not just built; (b) add an SMS channel (Twilio) as a second alert path; (c) for a genuinely production deployment, evaluate integrating a real crisis-response service rather than just displaying 988/741741 as static text.

### Manual escalation (for the operator, until the above is automated)
Until real-time alerting is fully wired and trusted, periodically check the parent dashboard for flagged messages across real families — not just rely on the automated path. If a flag looks like a genuine, urgent risk to a real kid (not synthetic test data), treat it with the seriousness that implies: it is not this document's place to give clinical guidance, but at minimum, confirm the parent has actually been notified and can act on it.

### Mandatory reporting
Mandatory-reporting obligations for suspected child abuse or imminent risk vary by state and by who is operating the service. **This has not been reviewed by a lawyer.** Get real legal guidance before treating any output of this system as satisfying (or not requiring) a mandatory-reporting obligation.

---
*This document should be revisited whenever safety-detection logic, alerting, or data-handling changes materially — it reflects the product as of the commit that introduced it, not a permanent guarantee.*
