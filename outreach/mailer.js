// ── EMAIL SENDING (Gmail SMTP via App Password) ──
// Uses a Gmail App Password over standard SMTP — not the Gmail API — so
// there's no OAuth verification/CASA assessment to deal with. See
// GMAIL_APP_PASSWORD / GMAIL_ADDRESS in Railway env vars.

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_ADDRESS;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set');
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass }
  });
  return transporter;
}

// Resolves the one-pager PDF for a given city tab name. Returns null (and
// logs a warning) if no matching file exists yet — the email still sends,
// just without an attachment, rather than failing the whole send.
function resolveOnePager(cityTabName) {
  const slug = cityTabName.trim().toLowerCase().replace(/\s+/g, '-');
  const filePath = path.join(__dirname, '..', 'one-pagers', `${slug}.pdf`);
  if (fs.existsSync(filePath)) return filePath;
  console.warn(`[outreach] No one-pager found for city "${cityTabName}" (expected one-pagers/${slug}.pdf)`);
  return null;
}

async function sendOutreachEmail({ to, subject, text, cityTabName }) {
  const t = getTransporter();
  const onePagerPath = resolveOnePager(cityTabName);
  const attachments = onePagerPath
    ? [{ filename: path.basename(onePagerPath), path: onePagerPath }]
    : [];

  await t.sendMail({
    from: `Kyle @ Zoros <${process.env.GMAIL_ADDRESS}>`,
    to,
    subject,
    text,
    attachments
  });
}

module.exports = { sendOutreachEmail, resolveOnePager };
