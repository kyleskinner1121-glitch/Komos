// ── EMAIL DRAFTING (Claude API) ──
// Drafts a personalized outreach email per bar using Claude, grounded in
// two approved voice references so it doesn't drift into generic copy.
// Uses forced tool use so the response comes back as clean {subject, body}
// instead of free text we'd have to parse.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// ^ Confirm this is still a current model ID in the Anthropic Console
//   (console.anthropic.com) before relying on it — model names change.

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client = new Anthropic({ apiKey });
  return client;
}

const VOICE_REFERENCES = `
Reference email A (direct/professional register):
---
Subject: A quick idea for St. James's Gate — free extra revenue stream

Hey St. James's Gate team,

We're building Zoros — a digital jukebox that lets your guests pay to pick the next song straight from their phone. No app, no hardware, it just plugs into the Spotify you're already running.

We're piloting it with a handful of bars in Amsterdam this month, and we'd love St. James's Gate to be one of them.

Two things that matter most: it costs you nothing, ever — €0 upfront, €0 ongoing, you just keep 75% of what gets played during the pilot. And you're always in control — skip or override any request, any time. If a song doesn't fit the vibe, it never plays.

I've attached a quick one-pager with the details. Up for a 15-minute call, or happy to just swing by and show you live — whichever's easier for you.

Best,
Kyle
Zoros
---

Reference email B (casual/personal register — approved as-is, including the generic vibe compliment):
---
Subject: Quick idea for [Bar Name] — free extra revenue stream

Hey [Bar Name] team,

Love the vibe you've got going at [Bar Name] — that's actually part of why we're reaching out.

We're building Zoros, a digital jukebox that lets your guests pay to pick the next song straight from their phone. No app, no hardware, it just plugs into the Spotify you're already running. Bars running systems like this are seeing real extra revenue, just from guests wanting to hear their song next.

We're picking 5-10 bars in [City] to pilot with this month, and we'd love [Bar Name] to be one of them. It costs nothing — €0 upfront, €0 ongoing, you keep 75% of what's played — and you're always in control: skip or override anything that doesn't fit the vibe.

Got 15 minutes this week for a quick call, or happy to swing by and show you live? You can also check out @zoros.music on Instagram if you want a feel for it first.

Best,
Kyle
Zoros
---
`.trim();

const DRAFT_TOOL = {
  name: 'draft_email',
  description: 'Submit the finished outreach email.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'The email subject line.' },
      body: { type: 'string', description: 'The plain-text email body, signed "Kyle / Zoros".' }
    },
    required: ['subject', 'body']
  }
};

async function draftEmail({ bar, cityTabName, mode }) {
  const anthropic = getClient();

  const modeInstructions = mode === 'followup'
    ? `This is a FOLLOW-UP. The bar was already emailed once (about 6 days ago, or — for a bar that had a prior non-agent contact — this is the very first email the agent itself is sending, but it should read like a light follow-up rather than a cold-open, since some prior contact with the bar already happened). Keep it noticeably shorter than a first-touch email, low-pressure, no guilt-tripping about not replying. Reference that you reached out before without being pushy about it. Still needs the core facts (€0 cost, 75% revenue share, always in control) but can state them more briefly since this isn't the first touch.`
    : `This is the FIRST-TOUCH email — the bar hasn't heard from Zoros by email before.`;

  const userPrompt = `
Draft a personalized outreach email for this bar, in Kyle's voice. Blend/vary between the two reference registers below (direct-professional vs casual-personal) rather than reusing either one verbatim — every email should read as freshly written, not templated, even though many are going out.

Bar name: ${bar.barName}
City: ${cityTabName}
Neighborhood: ${bar.neighborhood || 'unknown'}

${modeInstructions}

Requirements for every email, first-touch or follow-up:
- Mention it costs the bar nothing: €0 upfront, €0 ongoing.
- Mention the bar keeps 75% of revenue during the pilot.
- Mention the bar is always in control — can skip/override any song request, any time.
- Mention Kyle's Instagram, @zoros.music, as a way to see more.
- Sign off as "Kyle" / "Zoros".
- Do NOT invent specific revenue figures beyond what's in the reference emails (no "€X,XXX/month" claims) — keep any revenue-potential language directional, not a specific unverified number.
- Do NOT claim to have personally visited the bar or seen anything specific about it beyond its name/neighborhood — a generic warm compliment on the bar/neighborhood's vibe is fine (this is an approved choice, not an oversight), but don't fabricate specific visit details.
- Plain text only, no markdown formatting, no placeholder brackets left in the output.

${VOICE_REFERENCES}
`.trim();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: 'draft_email' },
    messages: [{ role: 'user', content: userPrompt }]
  });

  const toolUse = response.content.find(block => block.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a draft_email tool call');
  return { subject: toolUse.input.subject, body: toolUse.input.body };
}

module.exports = { draftEmail };
