// ── REPLY DETECTION (Gmail IMAP via App Password) ──
// Opens the inbox once per agent run and collects every sender address
// that's emailed zorosmusic@gmail.com since a given date. run.js checks
// each bar's email address against that set rather than the agent needing
// to understand what a reply says — Kyle reads the actual replies himself.

const { ImapFlow } = require('imapflow');

// Returns a Set of lowercased sender email addresses found in INBOX with
// an internal date on/after `sinceDate` (a JS Date).
async function getRepliedAddressesSince(sinceDate) {
  const user = process.env.GMAIL_ADDRESS;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false
  });

  const replied = new Set();
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch({ since: sinceDate }, { envelope: true })) {
        const from = msg.envelope && msg.envelope.from && msg.envelope.from[0];
        if (from && from.address) {
          replied.add(from.address.toLowerCase());
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return replied;
}

module.exports = { getRepliedAddressesSince };
