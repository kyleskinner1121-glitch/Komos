// ── ZOROS LINKS SHEET ──
// Writes each bar's login email and password into the team's "Zoros Links" Google Sheet,
// so new bars and password resets never have to be copied over by hand.
// Uses the same service account as the outreach agent (GOOGLE_SERVICE_ACCOUNT_KEY);
// the sheet must be shared with that service account's email as an Editor.
// Columns are found by their header text, so they can be reordered in the sheet.

const { google } = require('googleapis');

const SHEET_ID = process.env.ZOROS_LINKS_SHEET_ID || '14dUVmojmfiGDFj2HeNd1ZTHF9f3cjguGJ_0h0e8dSBo';
const TAB = 'Links';

function getSheetsClient() {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(rawKey),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// 0 → A, 25 → Z, 26 → AA
function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Reads the Links tab and finds the bars table's header row and the bar's row (-1 if missing).
async function findBarRow(sheets, venueId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:Z1000` });
  const rows = res.data.values || [];
  const headerIdx = rows.findIndex(r => r.includes('Venue ID') && r.includes('Password'));
  if (headerIdx === -1) throw new Error('No bars table on the Links tab (a header row with "Venue ID" and "Password")');
  const header = rows[headerIdx];
  const col = h => header.indexOf(h);
  const rowIdx = rows.findIndex((r, i) => i > headerIdx && r[col('Venue ID')] === venueId);
  return { rows, headerIdx, col, rowIdx };
}

const cellRef = (col, h, rowIdx, value) =>
  col(h) === -1 ? null : { range: `${TAB}!${colLetter(col(h))}${rowIdx + 1}`, values: [[value]] };

async function writeCells(sheets, data, valueInputOption) {
  data = data.filter(Boolean);
  if (data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption, data } });
}

// Updates the bar's row (matched on Venue ID), or adds a row under the bars table if it isn't there yet.
async function syncBarLogin({ name, venueId, email, password, baseUrl, status }) {
  const sheets = getSheetsClient();
  const { rows, headerIdx, col, rowIdx: found } = await findBarRow(sheets, venueId);
  let rowIdx = found;
  const isNew = rowIdx === -1;
  if (isNew) {
    rowIdx = headerIdx + 1;
    while (rows[rowIdx] && rows[rowIdx].some(v => v)) rowIdx++;
  }

  const cell = (h, value) => cellRef(col, h, rowIdx, value);
  // RAW so a name or password is never read as a formula, number or date
  const raw = [cell('Login email', email), cell('Password', password)];
  if (status) raw.push(cell('Status', status));
  // Links go in as typed so Sheets makes them clickable
  const typed = [];
  if (isNew) {
    raw.push(cell('Bar', name), cell('Venue ID', venueId));
    if (baseUrl) {
      typed.push(
        cell('Patron jukebox (QR code link)', `${baseUrl}/?venue=${venueId}`),
        cell('Bartender dashboard', `${baseUrl}/bar?venue=${venueId}`)
      );
    }
  }

  await writeCells(sheets, raw, 'RAW');
  await writeCells(sheets, typed, 'USER_ENTERED');
  return { row: rowIdx + 1, added: isNew };
}

// Sets a bar's Status, and clears its password when clearPassword is set. No row, nothing to do.
async function setBarStatus(venueId, status, { clearPassword = false } = {}) {
  const sheets = getSheetsClient();
  const { col, rowIdx } = await findBarRow(sheets, venueId);
  if (rowIdx === -1) return { row: null };
  const cells = [cellRef(col, 'Status', rowIdx, status)];
  if (clearPassword) cells.push(cellRef(col, 'Password', rowIdx, ''));
  await writeCells(sheets, cells, 'RAW');
  return { row: rowIdx + 1 };
}

const markBarRemoved = venueId => setBarStatus(venueId, 'Removed', { clearPassword: true });

module.exports = { syncBarLogin, markBarRemoved, setBarStatus };
