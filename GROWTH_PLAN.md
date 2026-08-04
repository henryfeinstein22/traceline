# Traceline — Growth & Business Plan

Written 2026-08-04, based on the product's actual current state (not aspirational). Updated further by the "Traceline strategy digest" recurring job — check for newer entries below this line when reviewing.

## Is this a business or a side project? Be honest first.

Right now: one real family using it (you), a working product, zero paying customers, zero real external users. That's not a business yet — it's a validated mechanism (per the one-pager's own framing) with an unproven demand bet. The single most important thing between here and "business" isn't another feature — it's getting real strangers to use it and seeing if they come back. Everything below is in service of that, not a replacement for it.

## Monetization — don't do this yet, but know the shape

Three real options, in order of how well they fit a trust-layer product:

1. **B2B2C via schools** — the classroom/teacher feature already exists and is the most defensible, hardest-to-copy angle (homework provenance solves a real academic-integrity problem schools already pay to solve, e.g. Turnitin). A single pilot teacher who likes it can bring 20-30 kids at once, which is a far better acquisition mechanic than one family at a time. This is the path most likely to become a real business, but requires actual outreach to actual teachers — nothing about it is inevitable from the code being good.
2. **Freemium family plans** — free basic logging/safety flags, paid tier for compliance reports, multi-kid families, weekly digests. Reasonable long-term model, but premature at zero real users: charging now would kill the one thing you need most (signal on whether anyone wants this at all).
3. **Stay free, prove demand first** — the honest recommendation right now. Don't build billing. Every hour spent on Stripe integration before you have 20 real families is an hour not spent finding out if you have 20 real families.

## What "ready for the public" needs beyond features

This is the gap most likely to actually hurt someone if skipped, not just a nice-to-have:

- **An incident response plan for a real flagged self-harm disclosure.** Right now: it gets logged, flagged, and (once you add a `RESEND_API_KEY`) emailed to the parent. That's it. If a real kid discloses something serious and the parent doesn't see the email in time, there's no fallback. At minimum: the flagged-message UI should surface crisis resources (988, Crisis Text Line) directly to the *kid* in the moment, not just alert the parent after the fact — right now a flagged message doesn't change what the kid sees at all.
- **A privacy policy and terms of service.** None exist. For a product logging minors' conversations, this isn't optional once real strangers are involved — it's the difference between "a project" and something you could get in real trouble for.
- **COPPA-adjacent handling.** Parental consent is already captured at kid-profile creation, which is the right foundation — but there's no data retention/deletion policy, no documented process for a parent to request full deletion beyond what exists implicitly in the DB structure.

None of this needs to happen before the *soft* launch to people you know (the outreach drafts already written are fine for that). It needs to happen before anything resembling a public launch (Show HN, ads, cold outreach to strangers).

## Realistic first-100-users channels, ranked

1. **The outreach drafts already written** (Show HN + parenting-community post) — cheapest, already done, waiting on you to personally post them.
2. **One pilot teacher.** Find a single teacher (not a district, not a school — one person) willing to try the classroom code with their class. This tests the B2B2C path for real with minimal ask.
3. **Parenting communities** (local FB groups, r/Parenting) — slower, more skeptical audience, but the actual target user.
4. **Not recommended yet**: paid ads, cold email at scale, or anything that costs money before you know if the free version retains anyone.

## What would need to become true for this to be a real business

- Real families beyond you, returning more than once (the visit counter + interest signups now track whether this is happening at all).
- At least one teacher actually using the classroom feature with a real class.
- A parent opening the compliance report or provenance link for a reason that mattered to them (a teacher asked about it, a school required it) — not just because you asked them to try it.
- Evidence the safety system holds up on real, not synthetic, edge cases — the 219+ synthetic conversation batch (and the ongoing recurring batch job) is a stand-in for this, not a substitute for it.

---
*Entries below this line are appended by the automated "Traceline strategy digest" job. Each entry is dated and should be read as a supplement to, not a replacement for, the analysis above.*
