// ── OUTREACH AGENT ORCHESTRATOR ──
// One run = for every city tab in the Bar Tracker spreadsheet, for every
// eligible bar row: check for a reply, then decide whether to send a
// first-touch email, a follow-up, or nothing, and write the result back
// into the sheet. The sheet is the only state store — no database table.

const { listCityTabs, getBarRows, updateBarRow } = require('./sheets');
const { sendOutreachEmail } = require('./mailer');
const { draftEmail } = require('./claude');
const { getRepliedAddressesSince } = require('./imap');

const FOLLOW_UP_DAYS = 6;

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysBetween(dateStr, ref = new Date()) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return Math.floor((ref.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

// Was this bar already contacted by EMAIL before the agent ever touched it?
// (Instagram-only history does NOT count — per Kyle's "start fresh" rule.)
function hadPriorManualEmailContact(bar) {
  const primaryIsEmail = /email/i.test(bar.outreachChannel) && bar.status && !/^cold$/i.test(bar.status);
  const secondaryIsEmail = /email/i.test(bar.secondaryOutreach) && bar.status2 && !/^cold$/i.test(bar.status2);
  return primaryIsEmail || secondaryIsEmail;
}

function isEligible(bar) {
  if (!bar.email) return false;
  if (bar.fitScore !== 'A' && bar.fitScore !== 'B') return false;
  return true;
}

// Decide what action (if any) to take on a single row. Returns one of:
// { action: 'reply-detected' | 'first-touch' | 'follow-up' | 'skip', reason }
function decideAction(bar, repliedAddresses) {
  const emailLower = bar.email.toLowerCase();

  // A reply from this address always wins, regardless of what stage the row is in.
  if (bar.lastContact && repliedAddresses.has(emailLower) && !/^responded$/i.test(bar.status)) {
    return { action: 'reply-detected' };
  }

  // Already ran today for this row — never send twice in one run/day.
  if (bar.lastContact === todayStr()) {
    return { action: 'skip', reason: 'already contacted today' };
  }

  const agentNeverTouchedRow = !bar.lastContact;

  if (agentNeverTouchedRow && hadPriorManualEmailContact(bar)) {
    // Bar already got a real email from Kyle before the agent existed —
    // agent's first touch on this row is a follow-up, not a cold open,
    // and it's the ONLY automated touch this row gets.
    return { action: 'follow-up', mode: 'followup', isFinalTouch: true };
  }

  if (agentNeverTouchedRow) {
    return { action: 'first-touch', mode: 'first' };
  }

  if (bar.nextFollowUp) {
    const daysUntilDue = daysBetween(bar.nextFollowUp);
    if (daysUntilDue !== null && daysUntilDue >= 0) {
      return { action: 'follow-up', mode: 'followup', isFinalTouch: true };
    }
    return { action: 'skip', reason: `follow-up not due for ${-daysUntilDue} more day(s)` };
  }

  return { action: 'skip', reason: 'already fully contacted, nothing pending' };
}

async function runOutreachAgent({ spreadsheetId, dryRun = false, limitPerCity = null } = {}) {
  if (!spreadsheetId) throw new Error('spreadsheetId is required');

  const summary = { cities: {}, sent: 0, followUps: 0, repliesDetected: 0, skipped: 0, errors: [] };

  const cityTabs = await listCityTabs(spreadsheetId);

  // One IMAP pass per run, looking back far enough to catch a reply to the
  // oldest thing we might still be waiting on (first-touch + follow-up window).
  const since = new Date();
  since.setDate(since.getDate() - (FOLLOW_UP_DAYS + 2));
  let repliedAddresses = new Set();
  try {
    repliedAddresses = await getRepliedAddressesSince(since);
  } catch (e) {
    console.error('[outreach] IMAP reply check failed, continuing without it:', e.message);
    summary.errors.push(`IMAP check failed: ${e.message}`);
  }

  for (const tabName of cityTabs) {
    const cityLog = { checked: 0, sent: 0, followUps: 0, repliesDetected: 0, skipped: 0 };
    summary.cities[tabName] = cityLog;

    let rows;
    try {
      rows = await getBarRows(spreadsheetId, tabName);
    } catch (e) {
      console.error(`[outreach] Could not read tab "${tabName}":`, e.message);
      summary.errors.push(`Read failed for "${tabName}": ${e.message}`);
      continue;
    }

    let processedThisCity = 0;
    for (const bar of rows) {
      if (!isEligible(bar)) continue;
      cityLog.checked++;

      if (limitPerCity && processedThisCity >= limitPerCity) {
        cityLog.skipped++;
        summary.skipped++;
        continue;
      }

      let decision;
      try {
        decision = decideAction(bar, repliedAddresses);
      } catch (e) {
        summary.errors.push(`${tabName} / ${bar.barName}: decision error — ${e.message}`);
        continue;
      }

      try {
        if (decision.action === 'reply-detected') {
          cityLog.repliesDetected++;
          summary.repliesDetected++;
          if (!dryRun) {
            await updateBarRow(spreadsheetId, tabName, bar.sheetRow, {
              status: 'Responded',
              nextFollowUp: null
            });
          }
          console.log(`[outreach] ${tabName} / ${bar.barName}: reply detected, marked Responded`);
        } else if (decision.action === 'first-touch' || decision.action === 'follow-up') {
          // Count this as an attempt against the limit the moment we commit to
          // it, not only on success — otherwise a run where every draft fails
          // (e.g. an API billing issue) never trips the limit and burns through
          // every eligible bar instead of stopping at N like it's supposed to.
          processedThisCity++;

          const { subject, body } = await draftEmail({ bar, cityTabName: tabName, mode: decision.mode });

          if (!dryRun) {
            await sendOutreachEmail({ to: bar.email, subject, text: body, cityTabName: tabName });
            await updateBarRow(spreadsheetId, tabName, bar.sheetRow, {
              status: 'Contacted',
              lastContact: todayStr(),
              nextFollowUp: decision.isFinalTouch
                ? null
                : (() => { const d = new Date(); d.setDate(d.getDate() + FOLLOW_UP_DAYS); return d.toISOString().slice(0, 10); })()
            });
          }

          if (decision.action === 'first-touch') { cityLog.sent++; summary.sent++; }
          else { cityLog.followUps++; summary.followUps++; }

          console.log(`[outreach]${dryRun ? ' [DRY RUN]' : ''} ${tabName} / ${bar.barName}: sent ${decision.action} — "${subject}"`);
        } else {
          cityLog.skipped++;
          summary.skipped++;
        }
      } catch (e) {
        console.error(`[outreach] ${tabName} / ${bar.barName}: error — ${e.message}`);
        summary.errors.push(`${tabName} / ${bar.barName}: ${e.message}`);
      }
    }
  }

  return summary;
}

module.exports = { runOutreachAgent };
