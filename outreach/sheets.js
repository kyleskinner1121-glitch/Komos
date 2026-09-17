// ── GOOGLE SHEETS ACCESS (Bar Tracker) ──
// Reads/writes the Bar Tracker spreadsheet using a Google service account.
// The sheet itself is the single source of truth for outreach state — no
// separate database table. Each city lives on its own tab, and every tab
// is expected to follow the same 2-row header band + column layout as the
// original Amsterdam tab.

const { google } = require('googleapis');

// Column order every city tab must follow (row 3 of each tab, 0-indexed here).
const COLUMNS = [
  'num', 'barName', 'neighborhood', 'instagram', 'email', 'phone',
  'fitScore', 'fitReason', 'outreachChannel', 'status',
  'secondaryOutreach', 'status2', 'lastContact', 'nextFollowUp', 'notes'
];

const COL = Object.fromEntries(COLUMNS.map((name, i) => [name, i]));

function getSheetsClient() {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
  const credentials = JSON.parse(rawKey);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// Returns every tab name that actually follows the Bar Tracker layout (i.e.
// every city tab) — the spreadsheet can also hold utility tabs like
// "Objection Tracker" or "Companies & Contacts" that live alongside the
// city tabs but aren't a list of bars, so each candidate tab's row 3 is
// checked for the expected "#" / "Bar Name" header before it's included.
// This avoids ever misreading an unrelated tab's rows as bars to email.
async function listCityTabs(spreadsheetId) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const allTabs = meta.data.sheets.map(s => s.properties.title);

  const cityTabs = [];
  for (const tabName of allTabs) {
    try {
      const headerRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A3:B3`
      });
      const header = headerRes.data.values && headerRes.data.values[0];
      const looksLikeBarTracker = header && header[0] && header[1] &&
        header[0].trim() === '#' && /bar name/i.test(header[1]);
      if (looksLikeBarTracker) cityTabs.push(tabName);
    } catch (e) {
      // Couldn't read this tab's header — skip it rather than risk treating
      // it as a bar list.
    }
  }
  return cityTabs;
}

// Reads a single city tab and returns an array of row objects. Skips the
// 2-row header band (title + legend) and the real header row (row 3), and
// stops at the first fully-blank row of the Bar Tracker table (so we don't
// pick up the Objection Tracker / partner-lead tables further down the tab).
async function getBarRows(spreadsheetId, tabName) {
  const sheets = getSheetsClient();
  const range = `'${tabName}'!A4:O2000`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];

  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const barName = (raw[COL.barName] || '').trim();
    const num = (raw[COL.num] || '').trim();
    // Blank Bar Name AND blank # means we've run past the Bar Tracker table
    // into the spacer row before the next table on the tab.
    if (!barName && !num) break;
    if (!barName) continue;

    rows.push({
      sheetRow: i + 4, // actual 1-indexed row number in the sheet, for write-back
      num,
      barName,
      neighborhood: (raw[COL.neighborhood] || '').trim(),
      instagram: (raw[COL.instagram] || '').trim(),
      email: (raw[COL.email] || '').trim(),
      phone: (raw[COL.phone] || '').trim(),
      fitScore: (raw[COL.fitScore] || '').trim().toUpperCase(),
      outreachChannel: (raw[COL.outreachChannel] || '').trim(),
      status: (raw[COL.status] || '').trim(),
      secondaryOutreach: (raw[COL.secondaryOutreach] || '').trim(),
      status2: (raw[COL.status2] || '').trim(),
      lastContact: (raw[COL.lastContact] || '').trim(),
      nextFollowUp: (raw[COL.nextFollowUp] || '').trim()
    });
  }
  return rows;
}

// Writes Status, Last Contact, Next Follow-Up, and/or Notes back into a
// specific row. Pass nextFollowUp: null to clear that cell (e.g. once the
// one allowed follow-up has been sent, or a reply came in). `notes` is used
// to flag problems (a bounced/invalid address, a send that failed) directly
// in the sheet so they're visible without checking server logs.
async function updateBarRow(spreadsheetId, tabName, sheetRow, { status, lastContact, nextFollowUp, notes }) {
  const sheets = getSheetsClient();
  const statusCol = 'J';
  const lastContactCol = 'M';
  const nextFollowUpCol = 'N';
  const notesCol = 'O';

  const data = [];
  if (status !== undefined) {
    data.push({ range: `'${tabName}'!${statusCol}${sheetRow}`, values: [[status]] });
  }
  if (lastContact !== undefined) {
    data.push({ range: `'${tabName}'!${lastContactCol}${sheetRow}`, values: [[lastContact]] });
  }
  if (nextFollowUp !== undefined) {
    data.push({ range: `'${tabName}'!${nextFollowUpCol}${sheetRow}`, values: [[nextFollowUp || '']] });
  }
  if (notes !== undefined) {
    data.push({ range: `'${tabName}'!${notesCol}${sheetRow}`, values: [[notes]] });
  }
  if (!data.length) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data }
  });
}

module.exports = { listCityTabs, getBarRows, updateBarRow };
