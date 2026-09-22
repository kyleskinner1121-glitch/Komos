// ── GOOGLE SHEETS ACCESS (Bar Tracker) ──
// Reads/writes the Bar Tracker spreadsheet using a Google service account.
// The sheet itself is the single source of truth for outreach state — no
// separate database table. Each city lives on its own tab, and every tab
// is expected to follow the same 2-row header band + column layout as the
// original Amsterdam tab.
//
// IMPORTANT: as the number of city tabs grows, reading them one tab at a
// time (one API call per tab) runs into Google Sheets' per-minute read
// quota. Every read in this file uses batchGet so a whole run costs a
// small, fixed number of API calls no matter how many city tabs exist.

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
//
// Uses one batchGet for every tab's header row instead of one call per tab
// — with 30+ city tabs, one-call-per-tab blows through Google's per-minute
// read quota almost immediately.
async function listCityTabs(spreadsheetId) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const allTabs = meta.data.sheets.map(s => s.properties.title);
  if (!allTabs.length) return [];

  const ranges = allTabs.map(tabName => `'${tabName}'!A3:B3`);
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  const valueRanges = res.data.valueRanges || [];

  const cityTabs = [];
  for (let i = 0; i < allTabs.length; i++) {
    const header = valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0];
    const looksLikeBarTracker = header && header[0] && header[1] &&
      header[0].trim() === '#' && /bar name/i.test(header[1]);
    if (looksLikeBarTracker) cityTabs.push(allTabs[i]);
  }
  return cityTabs;
}

// Turns one tab's raw A4:O2000 values into row objects. Skips the 2-row
// header band (title + legend) and the real header row (row 3) — the caller
// already sliced to start at row 4 — and stops at the first fully-blank row
// of the Bar Tracker table (so we don't pick up the Objection Tracker /
// partner-lead tables further down the tab).
function parseBarRows(values) {
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

// Reads a single city tab and returns an array of row objects. Kept around
// for callers that only need one tab — the agent's main run loop uses
// getAllBarRows below instead, so a run with many city tabs doesn't make
// one Sheets API call per tab.
async function getBarRows(spreadsheetId, tabName) {
  const sheets = getSheetsClient();
  const range = `'${tabName}'!A4:O2000`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return parseBarRows(res.data.values || []);
}

// Reads every given city tab's bar rows in ONE Sheets API call (via
// batchGet with one range per tab) instead of one call per tab. Returns
// { [tabName]: rows[] }. This is what keeps a run's Google Sheets API usage
// to a small, fixed number of calls no matter how many city tabs exist —
// critical once the spreadsheet has 20-30+ cities, since one-call-per-tab
// runs straight into Google's per-minute read quota.
async function getAllBarRows(spreadsheetId, tabNames) {
  if (!tabNames || !tabNames.length) return {};
  const sheets = getSheetsClient();
  const ranges = tabNames.map(tabName => `'${tabName}'!A4:O2000`);
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  const valueRanges = res.data.valueRanges || [];

  const result = {};
  for (let i = 0; i < tabNames.length; i++) {
    const values = (valueRanges[i] && valueRanges[i].values) || [];
    result[tabNames[i]] = parseBarRows(values);
  }
  return result;
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

module.exports = { listCityTabs, getBarRows, getAllBarRows, updateBarRow };
