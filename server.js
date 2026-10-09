// v7
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const { runOutreachAgent } = require('./outreach/run');
const crypto = require('crypto');
const { syncBarLogin, markBarRemoved, setBarStatus, upsertUser, syncAllUsers } = require('./links-sheet');

// ── OUTREACH AGENT CONFIG ──
// Spreadsheet ID from the Bar Tracker's URL (docs.google.com/spreadsheets/d/<THIS>/edit).
// Overridable via env var in case the sheet ever changes without a code edit.
const BAR_TRACKER_SHEET_ID = process.env.BAR_TRACKER_SHEET_ID || '1uKiVOtCNHVNYQyjYmmpzvosUOh79BDFxrShsS99ssWA';

const app = express();

// ── OLD ADDRESS → ZOROS DOMAIN ──
// Page visits to the Railway address (old QR codes, bookmarks) move to BASE_URL, keeping the path and ?venue=.
// Only kicks in while BASE_URL is a non-Railway domain. 302, not 301, so browsers do not remember it if that ever changes.
const CANONICAL = (() => {
  try { return new URL(process.env.BASE_URL); } catch { return null; }
})();
app.use((req, res, next) => {
  const host = (req.get('host') || '').toLowerCase();
  if (CANONICAL && !CANONICAL.hostname.endsWith('.up.railway.app') && host.endsWith('.up.railway.app')
      && (req.method === 'GET' || req.method === 'HEAD')) {
    return res.redirect(302, CANONICAL.origin + req.originalUrl);
  }
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── SESSIONS ──
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'zoros-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

// Returns true the first time a Stripe session is claimed, false on every repeat.
// Also records what was paid, at which bar, from which QR, and test vs live — for the team dashboard.
async function claimPayment(sessionId, kind, stripeSession) {
  const s = stripeSession || {};
  const m = s.metadata || {};
  try {
    await pool.query(
      'INSERT INTO processed_payments (session_id, kind, amount, venue_id, src, livemode, split_to, bar_amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [sessionId, kind, s.amount_total ?? null, m.venueId || null, m.src || null, stripeSession ? !!s.livemode : null,
       m.splitTo || null, m.splitTo ? parseInt(m.barAmount, 10) || null : null]
    );
  } catch (e) {
    if (e.code === '23505' || /duplicate|unique/i.test(e.message)) return false; // already claimed
    throw e;
  }
  recordStripeFee(sessionId, s); // best-effort, doesn't block the patron
  return true;
}

// Looks up the real Stripe fee for a payment and stores it. Never throws.
async function recordStripeFee(sessionId, s) {
  try {
    if (!s || !s.payment_intent) return;
    const piId = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id;
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge.balance_transaction'] });
    const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
    if (bt && typeof bt.fee === 'number') {
      // Prices are in euros, but Stripe reports the fee in the Zoros account's own currency (USD).
      // Convert back with the payment's exchange rate so fees and prices are in the same currency.
      const sameCurrency = !s.currency || bt.currency === s.currency;
      const fee = sameCurrency ? bt.fee : (bt.exchange_rate ? Math.round(bt.fee / bt.exchange_rate) : null);
      if (fee != null) await pool.query('UPDATE processed_payments SET stripe_fee = $1 WHERE session_id = $2', [fee, sessionId]);
    }
  } catch (e) {
    console.error('[stats] Stripe fee lookup failed:', e.message);
  }
}

// QR source tag from the URL (?src=poster) — letters, numbers, - and _ only
function cleanSrc(src) {
  return String(src || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || null;
}

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venue_tokens (
        venue_id VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS songs (
        id BIGINT PRIMARY KEY,
        track_id VARCHAR(255),
        name TEXT,
        artist TEXT,
        image TEXT,
        uri TEXT,
        venue_id VARCHAR(255),
        user_id INTEGER,
        added_at TIMESTAMP DEFAULT NOW(),
        status VARCHAR(50) DEFAULT 'queued',
        played_at TIMESTAMP,
        added_to_spotify BOOLEAN DEFAULT FALSE,
        amount_paid INTEGER DEFAULT 99
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        credits INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venues (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        city VARCHAR(255),
        venue_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venue_applications (
        id SERIAL PRIMARY KEY,
        venue_name VARCHAR(255) NOT NULL,
        city VARCHAR(255),
        contact_name VARCHAR(255) NOT NULL,
        role VARCHAR(255),
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        volume VARCHAR(50),
        message TEXT,
        status VARCHAR(50) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // One row per Stripe checkout session we've already honored — stops a refresh
    // of the success page (or a reused session_id) from queuing songs / adding credits twice.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_payments (
        session_id VARCHAR(255) PRIMARY KEY,
        kind VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Bar music settings (explicit filter, blocked genres). ADD COLUMN IF NOT EXISTS
    // means this runs safely on every start — no manual migration needed.
    await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb`);
    // Team dashboard: payment details, page visits, and bar payouts. All safe to re-run on every start.
    await pool.query(`ALTER TABLE processed_payments
      ADD COLUMN IF NOT EXISTS amount INTEGER,
      ADD COLUMN IF NOT EXISTS venue_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS src VARCHAR(64),
      ADD COLUMN IF NOT EXISTS livemode BOOLEAN,
      ADD COLUMN IF NOT EXISTS stripe_fee INTEGER`);
    // Automatic split (Stripe Connect): the bar's connected account, and per payment whether
    // Stripe paid the bar directly and how much (euro cents)
    await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255)`);
    // Songs a bar removed after they were already sent to Spotify. Spotify can't delete from a
    // queue, so Zoros skips each one the moment it starts playing.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spotify_skips (
        id SERIAL PRIMARY KEY,
        venue_id VARCHAR(255) NOT NULL,
        uri VARCHAR(255) NOT NULL,
        name VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE processed_payments
      ADD COLUMN IF NOT EXISTS split_to VARCHAR(255),
      ADD COLUMN IF NOT EXISTS bar_amount INTEGER`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS page_visits (
        id SERIAL PRIMARY KEY,
        venue_id VARCHAR(255),
        src VARCHAR(64),
        visitor_id VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS page_visits_venue_time ON page_visits (venue_id, created_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venue_payouts (
        id SERIAL PRIMARY KEY,
        venue_id VARCHAR(255) NOT NULL,
        amount INTEGER NOT NULL,
        note TEXT,
        paid_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Bars taken out of service (test bars, bars that left). Kept apart from venues so a bar
    // with no account can be removed too, and its songs and payments stay in the history.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS removed_venues (
        venue_id VARCHAR(255) PRIMARY KEY,
        removed_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database initialized');
  } catch (e) {
    console.error('DB init error:', e);
  }
}

initDB();

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireVenueAuth(req, res, next) {
  if (!req.session.venueId) return res.status(401).json({ error: 'Not logged in as venue' });
  next();
}

// ── PATRON ACCOUNTS → ZOROS LINKS "Users" TAB ──
// Runs after the response is sent and never throws, so a slow or failing sheet can't
// hold up a sign-up or a song. The database stays the record; the tab mirrors it.
const USER_SHEET_SQL = `
  SELECT u.email, u.created_at, u.credits,
         (SELECT COUNT(*) FROM songs s WHERE s.user_id = u.id) AS songs_used,
         (SELECT MAX(s.added_at) FROM songs s WHERE s.user_id = u.id) AS last_song
  FROM users u`;
async function syncUserToSheet(userId) {
  try {
    const r = await pool.query(`${USER_SHEET_SQL} WHERE u.id = $1`, [userId]);
    if (r.rows[0]) await upsertUser(r.rows[0]);
  } catch (e) {
    console.error('[links-sheet] user sync failed:', e.message);
  }
}

// ── USER AUTH ROUTES ──
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, credits',
      [email.toLowerCase(), hash]
    );
    req.session.userId = result.rows[0].id;
    req.session.email = result.rows[0].email;
    res.json({ success: true, user: { email: result.rows[0].email, credits: result.rows[0].credits } });
    syncUserToSheet(result.rows[0].id);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(400).json({ error: 'No account found with that email' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Incorrect password' });
    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ success: true, user: { email: user.email, credits: user.credits } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const result = await pool.query('SELECT id, email, credits FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user: result.rows[0] });
  } catch (e) {
    res.json({ loggedIn: false });
  }
});

// ── VENUE AUTH ROUTES ──
app.post('/api/venue/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT * FROM venues WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(400).json({ error: 'No venue found with that email' });
    const venue = result.rows[0];
    const match = await bcrypt.compare(password, venue.password_hash);
    if (!match) return res.status(400).json({ error: 'Incorrect password' });
    if (await venueIsRemoved(venue.venue_id)) return res.status(400).json({ error: 'This bar account has been closed. Contact Zoros.' });
    req.session.venueId = venue.venue_id;
    req.session.venueName = venue.name;
    // ── FIX: check spotify connection at login time ──
    const spotifyToken = await getVenueToken(venue.venue_id);
    res.json({ success: true, venue: { name: venue.name, city: venue.city, venueId: venue.venue_id, isActive: venue.is_active, spotifyConnected: !!spotifyToken } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/venue/logout', (req, res) => {
  req.session.venueId = null;
  req.session.venueName = null;
  res.json({ success: true });
});

app.get('/api/venue/me', async (req, res) => {
  if (!req.session.venueId) return res.json({ loggedIn: false });
  try {
    const result = await pool.query('SELECT name, city, venue_id, is_active FROM venues WHERE venue_id = $1', [req.session.venueId]);
    if (!result.rows.length || await venueIsRemoved(req.session.venueId)) return res.json({ loggedIn: false });
    const venue = result.rows[0];
    const token = await getVenueToken(venue.venue_id);
    res.json({ loggedIn: true, venue: { name: venue.name, city: venue.city, venueId: venue.venue_id, isActive: venue.is_active, spotifyConnected: !!token } });
  } catch (e) {
    res.json({ loggedIn: false });
  }
});

// ── VENUE TOGGLE ON/OFF ──
app.post('/api/venue/toggle', requireVenueAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE venues SET is_active = NOT is_active WHERE venue_id = $1 RETURNING is_active',
      [req.session.venueId]
    );
    res.json({ success: true, isActive: result.rows[0].is_active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Is the bar's jukebox switched on? Removed bars are always off; unknown venues count as on.
async function venueIsActive(venueId) {
  try {
    const r = await pool.query(
      `SELECT (SELECT is_active FROM venues WHERE venue_id = $1) AS active,
              EXISTS (SELECT 1 FROM removed_venues WHERE venue_id = $1) AS removed`, [venueId]);
    const { active, removed } = r.rows[0];
    return !removed && active !== false;
  } catch (e) {
    return true;
  }
}

async function venueIsRemoved(venueId) {
  const r = await pool.query('SELECT 1 FROM removed_venues WHERE venue_id = $1', [venueId]);
  return r.rows.length > 0;
}

// ── VENUE MUSIC SETTINGS ──
app.get('/api/venue/settings', requireVenueAuth, async (req, res) => {
  res.json({ settings: await getVenueSettings(req.session.venueId) });
});

app.post('/api/venue/settings', requireVenueAuth, async (req, res) => {
  try {
    const settings = cleanSettings(req.body);
    await pool.query('UPDATE venues SET settings = $1 WHERE venue_id = $2', [JSON.stringify(settings), req.session.venueId]);
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VENUE ACTIVE STATUS (for patron app) ──
app.get('/api/venue/active', async (req, res) => {
  const venueId = req.query.venueId || 'default';
  // The bar's name is shown in the patron page header; bars without an account have none
  const r = await pool.query('SELECT name FROM venues WHERE venue_id = $1', [venueId]).catch(() => ({ rows: [] }));
  res.json({ isActive: await venueIsActive(venueId), name: r.rows[0] ? r.rows[0].name : null });
});

// ── VENUE REVENUE ──
app.get('/api/venue/revenue', requireVenueAuth, async (req, res) => {
  const venueId = req.session.venueId;
  try {
    const today = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0) as total, COUNT(*) as count
       FROM songs WHERE venue_id = $1 AND added_at >= NOW() - INTERVAL '1 day'`,
      [venueId]
    );
    const week = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0) as total, COUNT(*) as count
       FROM songs WHERE venue_id = $1 AND added_at >= NOW() - INTERVAL '7 days'`,
      [venueId]
    );
    const month = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0) as total, COUNT(*) as count
       FROM songs WHERE venue_id = $1 AND added_at >= NOW() - INTERVAL '30 days'`,
      [venueId]
    );
    const allTime = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0) as total, COUNT(*) as count
       FROM songs WHERE venue_id = $1`,
      [venueId]
    );
    res.json({
      today: { total: parseInt(today.rows[0].total), count: parseInt(today.rows[0].count) },
      week: { total: parseInt(week.rows[0].total), count: parseInt(week.rows[0].count) },
      month: { total: parseInt(month.rows[0].total), count: parseInt(month.rows[0].count) },
      allTime: { total: parseInt(allTime.rows[0].total), count: parseInt(allTime.rows[0].count) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VENUE INSIGHTS ──
app.get('/api/venue/insights', requireVenueAuth, async (req, res) => {
  const venueId = req.session.venueId;
  try {
    const topSongs = await pool.query(
      `SELECT name, artist, image, COUNT(*) as play_count
       FROM songs WHERE venue_id = $1
       GROUP BY name, artist, image
       ORDER BY play_count DESC LIMIT 10`,
      [venueId]
    );
    const busyHours = await pool.query(
      `SELECT EXTRACT(HOUR FROM added_at) as hour, COUNT(*) as count
       FROM songs WHERE venue_id = $1
       GROUP BY hour ORDER BY hour ASC`,
      [venueId]
    );
    const totalPlayed = await pool.query(
      `SELECT COUNT(*) as count FROM songs WHERE venue_id = $1 AND status = 'played'`,
      [venueId]
    );
    res.json({
      topSongs: topSongs.rows,
      busyHours: busyHours.rows,
      totalPlayed: parseInt(totalPlayed.rows[0].count)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: CREATE VENUE ──
// ── VENUE APPLICATIONS (pilot signup form) ──
app.post('/api/apply', async (req, res) => {
  const { venueName, city, contactName, role, email, phone, volume, message } = req.body;
  if (!venueName || !contactName || !email) {
    return res.status(400).json({ error: 'Venue name, contact name, and email are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO venue_applications (venue_name, city, contact_name, role, email, phone, volume, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [venueName, city || null, contactName, role || null, email.toLowerCase(), phone || null, volume || null, message || null]
    );

    // Notify the team by email (skips silently if RESEND_API_KEY isn't set)
    if (resend) {
      try {
        await resend.emails.send({
          from: process.env.NOTIFY_FROM || 'Zoros Applications <onboarding@resend.dev>',
          to: process.env.NOTIFY_EMAIL || 'team@zorosmusic.com',
          subject: `New pilot application: ${venueName}`,
          html: `
            <h2>New Zoros pilot application</h2>
            <p><strong>Venue:</strong> ${venueName}</p>
            <p><strong>City:</strong> ${city || '—'}</p>
            <p><strong>Contact:</strong> ${contactName}${role ? ` (${role})` : ''}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> ${phone || '—'}</p>
            <p><strong>Typical night volume:</strong> ${volume || '—'}</p>
            <p><strong>Message:</strong><br>${message ? message.replace(/\n/g, '<br>') : '—'}</p>
          `
        });
      } catch (emailErr) {
        console.error('Application email notify error:', emailErr);
      }
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (e) {
    console.error('Application submit error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/admin/applications', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query('SELECT * FROM venue_applications ORDER BY created_at DESC');
    res.json({ applications: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: BAR ACCOUNTS ──
// Zoros sets every bar's password (bars can't change it), so the team always has the current one.
// Each new or reset password is also written to the Zoros Links sheet; if that write fails, the
// account change still stands and the dashboard shows the password to copy over by hand.

// 12 characters in groups of 4, e.g. "kp7R-m3Qx-9tLw". No look-alike characters (0/O, 1/l/I).
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const chars = letters + '23456789';
  let out = letters[crypto.randomInt(letters.length)];
  while (out.length < 12) out += chars[crypto.randomInt(chars.length)];
  return out.match(/.{4}/g).join('-');
}

// Log a bar out on every device. Never throws: callers have already made their change,
// and the session table only exists once someone has logged in.
async function logOutVenue(venueId) {
  await pool.query(`DELETE FROM session WHERE sess->>'venueId' = $1`, [venueId])
    .catch(e => { if (e.code !== '42P01') console.error('[logout] failed for', venueId, e.message); });
}

async function syncLoginToSheet(venue, password, status) {
  try {
    await syncBarLogin({ name: venue.name, venueId: venue.venue_id, email: venue.email, password, baseUrl: process.env.BASE_URL, status });
    return { sheetSynced: true };
  } catch (e) {
    console.error('[links-sheet] sync failed:', e.message);
    return { sheetSynced: false, sheetError: e.message };
  }
}

app.post('/api/admin/create-venue', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const name = String(req.body.name || '').trim();
  const city = String(req.body.city || '').trim();
  const venueId = String(req.body.venueId || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !city || !venueId || !email) return res.status(400).json({ error: 'Name, city, venue ID and email are all required' });
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(venueId)) return res.status(400).json({ error: 'Venue ID can only use lowercase letters, numbers and single hyphens' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right' });
  try {
    if (await venueIsRemoved(venueId)) return res.status(400).json({ error: 'That venue ID belonged to a removed bar. Pick a different one.' });
    const existing = await pool.query('SELECT email, venue_id FROM venues WHERE email = $1 OR venue_id = $2', [email, venueId]);
    if (existing.rows.length) {
      const taken = existing.rows[0].venue_id === venueId ? 'That venue ID' : 'That email';
      return res.status(400).json({ error: `${taken} already has an account` });
    }
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO venues (name, city, venue_id, email, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING name, city, venue_id, email',
      [name, city, venueId, email, hash]
    );
    const venue = result.rows[0];
    res.json({ success: true, venue, password, ...(await syncLoginToSheet(venue, password)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// New password for a bar. The old one stops working and any device logged in as the bar is logged out.
app.post('/api/admin/reset-password', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const { venueId } = req.body || {};
  try {
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'UPDATE venues SET password_hash = $1 WHERE venue_id = $2 RETURNING name, city, venue_id, email',
      [hash, venueId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No bar account with that venue ID' });
    await logOutVenue(venueId);
    const venue = result.rows[0];
    res.json({ success: true, venue, password, ...(await syncLoginToSheet(venue, password)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Take a bar out of service. Its songs, payments and payouts stay, so money owed is still tracked.
// The jukebox closes for its QR codes, the login stops working, and its Spotify is disconnected.
app.post('/api/admin/remove-venue', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const venueId = String((req.body && req.body.venueId) || '').trim();
  if (!venueId) return res.status(400).json({ error: 'Which bar?' });
  try {
    await pool.query('INSERT INTO removed_venues (venue_id) VALUES ($1) ON CONFLICT DO NOTHING', [venueId]);
    await pool.query('UPDATE venues SET is_active = false WHERE venue_id = $1', [venueId]);
    await pool.query('DELETE FROM venue_tokens WHERE venue_id = $1', [venueId]);
    await logOutVenue(venueId);
    let sheet = { sheetSynced: true };
    try {
      await markBarRemoved(venueId);
    } catch (e) {
      console.error('[links-sheet] remove sync failed:', e.message);
      sheet = { sheetSynced: false, sheetError: e.message };
    }
    res.json({ success: true, ...sheet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bring a removed bar back. A bar with an account gets a new password (the sheet's copy was cleared
// on removal) and is marked Live; it has to reconnect Spotify. A bar with no account just reopens.
app.post('/api/admin/restore-venue', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const venueId = String((req.body && req.body.venueId) || '').trim();
  try {
    const gone = await pool.query('DELETE FROM removed_venues WHERE venue_id = $1 RETURNING venue_id', [venueId]);
    if (!gone.rows.length) return res.status(404).json({ error: 'That bar isn\'t removed' });
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'UPDATE venues SET is_active = true, password_hash = $1 WHERE venue_id = $2 RETURNING name, city, venue_id, email',
      [hash, venueId]
    );
    if (result.rows.length) {
      const venue = result.rows[0];
      return res.json({ success: true, venue, password, ...(await syncLoginToSheet(venue, password, 'Live')) });
    }
    let sheet = { sheetSynced: true };
    try {
      await setBarStatus(venueId, 'Test');
    } catch (e) {
      console.error('[links-sheet] restore sync failed:', e.message);
      sheet = { sheetSynced: false, sheetError: e.message };
    }
    res.json({ success: true, venue: null, ...sheet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fill the Users tab from the database: existing accounts, or to repair the tab
app.post('/api/admin/sync-users', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(`${USER_SHEET_SQL} ORDER BY u.created_at`);
    await syncAllUsers(r.rows);
    res.json({ success: true, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Link (or unlink, with an empty ID) a bar's Stripe connected account for the automatic split.
// Saved even if onboarding isn't finished; checkouts only split once Stripe says it's enabled.
app.post('/api/admin/stripe-account', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const venueId = String((req.body && req.body.venueId) || '').trim();
  const acct = String((req.body && req.body.accountId) || '').trim();
  if (acct && !/^acct_[A-Za-z0-9]+$/.test(acct)) return res.status(400).json({ error: 'A Stripe account ID starts with acct_' });
  try {
    const r = await pool.query('UPDATE venues SET stripe_account_id = $1 WHERE venue_id = $2 RETURNING name', [acct || null, venueId]);
    if (!r.rows.length) return res.status(404).json({ error: 'No bar account with that venue ID' });
    if (!acct) return res.json({ success: true, linked: false });
    const status = await connectedAccountStatus(acct, { fresh: true });
    res.json({ success: true, linked: true, ready: status.ok, status: status.reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Current Stripe status of every linked bar, for the dashboard
app.get('/api/admin/stripe-status', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT venue_id, stripe_account_id FROM venues WHERE stripe_account_id IS NOT NULL');
    const out = {};
    for (const v of r.rows) {
      const s = await connectedAccountStatus(v.stripe_account_id);
      out[v.venue_id] = { ready: s.ok, status: s.reason };
    }
    res.json({ success: true, bars: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PAGE VISIT TRACKING (patron app opens) ──
app.post('/api/track/visit', async (req, res) => {
  const { venueId, src, visitorId } = req.body || {};
  if (!venueId) return res.json({ ok: false });
  try {
    await pool.query(
      'INSERT INTO page_visits (venue_id, src, visitor_id) VALUES ($1, $2, $3)',
      [String(venueId).slice(0, 255), cleanSrc(src), String(visitorId || '').slice(0, 64) || null]
    );
  } catch (e) {
    console.error('[stats] visit log failed:', e.message);
  }
  res.json({ ok: true });
});

// ── ADMIN: TEAM DASHBOARD ──
const BAR_SHARE = 0.75;                      // bar's cut of each payment
const TEST_VENUES = ['demo', 'default'];     // hidden unless "include demo" is on

function isAdmin(req) {
  const key = req.get('x-admin-key') || req.query.adminKey || (req.body && req.body.adminKey);
  return !!process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

app.get('/api/admin/stats', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const days = { '24h': 1, '7d': 7, '30d': 30 }[req.query.range] || null; // null = all time
  const liveOnly = req.query.liveOnly === 'true';
  const includeDemo = req.query.includeDemo === 'true';
  const showRemoved = req.query.showRemoved === 'true';
  // Shared filters: $1 days, $2 liveOnly, $3 includeDemo, $4 test venue ids
  // Payment queries: $1 days, $2 liveOnly, $3 includeDemo, $4 test venue ids
  const params = [days, liveOnly, includeDemo, TEST_VENUES];
  // Activity queries (songs, visits): $1 days, $2 includeDemo, $3 test venue ids
  const aParams = [days, includeDemo, TEST_VENUES];
  const inRange = (col) => `($1::int IS NULL OR ${col} >= NOW() - ($1::int * INTERVAL '1 day'))`;
  const venueOk = (col) => `($3::boolean OR COALESCE(${col}, '') <> ALL($4::text[]))`;
  const aVenueOk = (col) => `($2::boolean OR COALESCE(${col}, '') <> ALL($3::text[]))`;
  const payWhere = `${inRange('p.created_at')} AND ($2::boolean = false OR p.livemode = true) AND ${venueOk('p.venue_id')}`;
  // Stripe fee: real when known, otherwise estimated at the standard EU card rate (1.5% + €0.25)
  const feeExpr = `COALESCE(p.stripe_fee, ROUND(p.amount * 0.015) + 25)`;
  // The bar's cut of a payment: 75% after the Stripe fee. When Stripe split it automatically,
  // use exactly what Stripe sent the bar.
  const barExpr = `COALESCE(p.bar_amount, ROUND((p.amount - ${feeExpr}) * ${BAR_SHARE}))`;
  try {
    const q = (sql, ps = params) => pool.query(sql, ps).then(r => r.rows);
    const [
      totals, payByVenue, songsByVenue, visitsByVenue, venues, owedRows,
      nightly, bySrcVisits, bySrcPays, recentSongs, topSongs, apps, payouts, modeCounts, removedRows
    ] = await Promise.all([
      q(`SELECT COUNT(*)::int AS payments,
                COALESCE(SUM(p.amount), 0)::int AS revenue,
                COALESCE(SUM(${feeExpr}), 0)::int AS fees,
                COUNT(*) FILTER (WHERE p.stripe_fee IS NULL)::int AS fees_estimated,
                COUNT(*) FILTER (WHERE p.kind = 'bundle')::int AS bundles,
                COALESCE(SUM(${barExpr}), 0)::int AS bar_share
         FROM processed_payments p WHERE p.amount IS NOT NULL AND ${payWhere}`),
      q(`SELECT p.venue_id, COUNT(*)::int AS payments, COALESCE(SUM(p.amount), 0)::int AS revenue,
                COALESCE(SUM(${feeExpr}), 0)::int AS fees, COALESCE(SUM(${barExpr}), 0)::int AS bar_share
         FROM processed_payments p WHERE p.amount IS NOT NULL AND ${payWhere} GROUP BY p.venue_id`),
      q(`SELECT s.venue_id, COUNT(*)::int AS songs, MAX(s.added_at) AS last_song
         FROM songs s WHERE ${inRange('s.added_at')} AND ${aVenueOk('s.venue_id')} GROUP BY s.venue_id`, aParams),
      q(`SELECT v.venue_id, COUNT(*)::int AS visits, COUNT(DISTINCT v.visitor_id)::int AS visitors
         FROM page_visits v WHERE ${inRange('v.created_at')} AND ${aVenueOk('v.venue_id')} GROUP BY v.venue_id`, aParams),
      q(`SELECT v.venue_id, v.name, v.city, v.is_active, v.created_at, v.stripe_account_id,
                (t.venue_id IS NOT NULL) AS spotify_connected
         FROM venues v LEFT JOIN venue_tokens t ON t.venue_id = v.venue_id ORDER BY v.created_at`, []),
      // What each bar is owed by hand: live payments only, all time, 75% after Stripe fees, minus
      // payouts already recorded. Payments Stripe split automatically are already paid, so left out.
      q(`SELECT x.venue_id, x.live_share, x.auto_paid, COALESCE(po.paid, 0)::int AS paid_out
         FROM (SELECT p.venue_id,
                      COALESCE(SUM(${barExpr}) FILTER (WHERE p.split_to IS NULL), 0)::int AS live_share,
                      COALESCE(SUM(p.bar_amount) FILTER (WHERE p.split_to IS NOT NULL), 0)::int AS auto_paid
               FROM processed_payments p
               WHERE p.livemode = true AND p.amount IS NOT NULL GROUP BY p.venue_id) x
         LEFT JOIN (SELECT venue_id, SUM(amount) AS paid FROM venue_payouts GROUP BY venue_id) po
           ON po.venue_id = x.venue_id`, []),
      // Last 30 nights, Madrid time, with a 6am cutoff so 1am sales count as the night before
      q(`SELECT to_char((p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid' - INTERVAL '6 hours')::date, 'YYYY-MM-DD') AS night,
                COUNT(*)::int AS payments, COALESCE(SUM(p.amount), 0)::int AS revenue
         FROM processed_payments p
         WHERE p.amount IS NOT NULL AND p.created_at >= NOW() - INTERVAL '31 days'
           AND ($1::boolean = false OR p.livemode = true) AND ($2::boolean OR COALESCE(p.venue_id, '') <> ALL($3::text[]))
         GROUP BY 1 ORDER BY 1`, [liveOnly, includeDemo, TEST_VENUES]),
      q(`SELECT COALESCE(v.src, '(no tag)') AS src, COUNT(*)::int AS visits, COUNT(DISTINCT v.visitor_id)::int AS visitors
         FROM page_visits v WHERE ${inRange('v.created_at')} AND ${aVenueOk('v.venue_id')} GROUP BY 1`, aParams),
      q(`SELECT COALESCE(NULLIF(p.src, ''), '(no tag)') AS src, COUNT(*)::int AS payments, COALESCE(SUM(p.amount), 0)::int AS revenue
         FROM processed_payments p WHERE p.amount IS NOT NULL AND ${payWhere} GROUP BY 1`),
      q(`SELECT s.name, s.artist, s.image, s.venue_id, s.added_at, s.status
         FROM songs s WHERE ($1::boolean OR COALESCE(s.venue_id, '') <> ALL($2::text[])) ORDER BY s.added_at DESC LIMIT 25`,
        [includeDemo, TEST_VENUES]),
      q(`SELECT s.name, s.artist, s.image, COUNT(*)::int AS plays
         FROM songs s WHERE ${inRange('s.added_at')} AND ${aVenueOk('s.venue_id')}
         GROUP BY s.name, s.artist, s.image ORDER BY plays DESC, MAX(s.added_at) DESC LIMIT 10`, aParams),
      q(`SELECT id, venue_name, city, contact_name, email, status, created_at
         FROM venue_applications ORDER BY created_at DESC LIMIT 8`, []),
      q(`SELECT venue_id, amount, note, paid_at FROM venue_payouts ORDER BY paid_at DESC LIMIT 20`, []),
      q(`SELECT COUNT(*) FILTER (WHERE livemode = true)::int AS live,
                COUNT(*) FILTER (WHERE livemode IS NOT TRUE)::int AS test
         FROM processed_payments WHERE amount IS NOT NULL`, []),
      q(`SELECT venue_id FROM removed_venues`, [])
    ]);

    const t = totals[0];
    const barShare = t.bar_share;

    // One row per bar: every registered venue, plus any venue id that has activity but no account (e.g. demo)
    const byId = {};
    const row = (id) => byId[id] || (byId[id] = {
      venue_id: id, name: null, is_active: null, spotify_connected: false,
      payments: 0, revenue: 0, fees: 0, songs: 0, last_song: null, visits: 0, visitors: 0,
      bar_share: 0, live_share: 0, auto_paid: 0, paid_out: 0
    });
    venues.forEach(v => {
      if (!includeDemo && TEST_VENUES.includes(v.venue_id)) return;
      Object.assign(row(v.venue_id), { name: v.name, city: v.city, is_active: v.is_active, spotify_connected: v.spotify_connected, created_at: v.created_at, stripe_account_id: v.stripe_account_id });
    });
    payByVenue.forEach(r => { if (r.venue_id) Object.assign(row(r.venue_id), { payments: r.payments, revenue: r.revenue, fees: r.fees, bar_share: r.bar_share }); });
    songsByVenue.forEach(r => { if (r.venue_id) Object.assign(row(r.venue_id), { songs: r.songs, last_song: r.last_song }); });
    visitsByVenue.forEach(r => { if (r.venue_id) Object.assign(row(r.venue_id), { visits: r.visits, visitors: r.visitors }); });
    owedRows.forEach(r => {
      if (!r.venue_id || (!includeDemo && TEST_VENUES.includes(r.venue_id))) return;
      Object.assign(row(r.venue_id), { live_share: r.live_share, auto_paid: r.auto_paid, paid_out: r.paid_out });
    });
    const removed = new Set(removedRows.map(r => r.venue_id));
    const allBars = Object.values(byId).map(b => ({
      ...b,
      removed: removed.has(b.venue_id),
      owed: Math.max(0, b.live_share - b.paid_out)
    })).sort((a, b) => b.revenue - a.revenue || b.songs - a.songs);
    // Removed bars are hidden unless asked for, but money still owed to them stays in the totals
    const bars = showRemoved ? allBars : allBars.filter(b => !b.removed);

    // QR sources: merge visits and payments on the tag
    const src = {};
    bySrcVisits.forEach(r => { src[r.src] = { src: r.src, visits: r.visits, visitors: r.visitors, payments: 0, revenue: 0 }; });
    bySrcPays.forEach(r => { src[r.src] = Object.assign(src[r.src] || { src: r.src, visits: 0, visitors: 0 }, { payments: r.payments, revenue: r.revenue }); });

    const visitors = visitsByVenue.reduce((n, r) => n + r.visitors, 0);
    const songs = songsByVenue.reduce((n, r) => n + r.songs, 0);
    res.json({
      generatedAt: new Date().toISOString(),
      filters: { range: req.query.range || 'all', liveOnly, includeDemo, showRemoved },
      removedCount: allBars.filter(b => b.removed).length,
      barSharePct: BAR_SHARE * 100,
      totals: {
        revenue: t.revenue, payments: t.payments, bundles: t.bundles, songs, visitors,
        barShare, fees: t.fees, feesEstimated: t.fees_estimated,
        zorosNet: t.revenue - barShare - t.fees,
        owedNow: allBars.reduce((n, b) => n + b.owed, 0)
      },
      paymentModes: modeCounts[0],
      bars,
      nightly,
      sources: Object.values(src).sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors),
      recentSongs, topSongs, applications: apps, payouts
    });
  } catch (e) {
    console.error('[stats] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Record that a bar has been paid (amount in cents)
app.post('/api/admin/payout', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const { venueId, amount, note } = req.body || {};
  const cents = parseInt(amount, 10);
  if (!venueId || !Number.isFinite(cents) || cents <= 0) return res.status(400).json({ error: 'Need a bar and an amount' });
  try {
    await pool.query('INSERT INTO venue_payouts (venue_id, amount, note) VALUES ($1, $2, $3)', [venueId, cents, note ? String(note).slice(0, 300) : null]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: RUN OUTREACH AGENT ──
// Manual trigger for testing. Query params:
//   adminKey  (required) — same ADMIN_KEY as the other admin endpoints
//   dryRun=true           — draft emails and log what WOULD happen, send/write nothing
//   limit=N                — process at most N eligible bars per city tab (safe for a first test)
app.get('/api/admin/run-outreach', async (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const dryRun = req.query.dryRun === 'true';
    const limitPerCity = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const summary = await runOutreachAgent({ spreadsheetId: BAR_TRACKER_SHEET_ID, dryRun, limitPerCity });
    res.json({ success: true, dryRun, summary });
  } catch (e) {
    console.error('[outreach] Manual run error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── BUNDLE PAYMENT ──
app.post('/api/create-bundle-payment', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Must be logged in to buy bundles' });
  const bundles = {
    single: { credits: 1, price: 99, label: '1 Song' },
    four: { credits: 4, price: 349, label: '4 Songs' },
    seven: { credits: 7, price: 549, label: '7 Songs' }
  };
  const { bundleType, venueId = 'default', src, lang } = req.body;
  const bundle = bundles[bundleType];
  if (!bundle) return res.status(400).json({ error: 'Invalid bundle' });
  try {
    const session = await createCheckout({
      locale: stripeLocale(lang),
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Zoros — ${bundle.label}`,
            description: `${bundle.credits} song credit${bundle.credits > 1 ? 's' : ''} for the Zoros jukebox`
          },
          unit_amount: bundle.price
        },
        quantity: 1
      }],
      mode: 'payment',
      metadata: { bundleType, userId: String(req.session.userId), venueId: String(venueId), src: cleanSrc(src) || '' },
      success_url: `${process.env.BASE_URL}/bundle-success?session_id={CHECKOUT_SESSION_ID}&bundle=${bundleType}&venue_id=${venueId}`,
      cancel_url: `${process.env.BASE_URL}?venue=${venueId}`
    }, venueId, bundle.price);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BUNDLE SUCCESS ──
app.post('/api/bundle/confirm', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const bundles = { single: 1, four: 4, seven: 7, five: 5, ten: 10 }; // five/ten kept for older checkouts
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session' });
  try {
    const stripeSession = await stripe.checkout.sessions.retrieve(session_id);
    if (stripeSession.payment_status !== 'paid') return res.status(400).json({ error: 'Payment not confirmed' });
    // Trust what was actually paid for (stored on the Stripe session), not the URL
    const meta = stripeSession.metadata || {};
    const credits = bundles[meta.bundleType];
    if (!credits) return res.status(400).json({ error: 'Invalid bundle' });
    if (meta.userId && meta.userId !== String(req.session.userId)) return res.status(403).json({ error: 'Payment belongs to another account' });
    if (!(await claimPayment(session_id, 'bundle', stripeSession))) {
      const cur = await pool.query('SELECT credits FROM users WHERE id = $1', [req.session.userId]);
      return res.json({ success: true, alreadyProcessed: true, credits: cur.rows[0]?.credits ?? 0 });
    }
    const result = await pool.query(
      'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
      [credits, req.session.userId]
    );
    res.json({ success: true, credits: result.rows[0].credits });
    syncUserToSheet(req.session.userId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── USE CREDIT TO QUEUE SONG ──
app.post('/api/queue/use-credit', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { track_id, track_name, artist, image, uri, venue_id = 'default' } = req.body;
  try {
    if (!(await venueIsActive(venue_id))) {
      return res.status(400).json({ error: 'off', off: true });
    }
    if (!(await spotifyIsPlaying(venue_id))) {
      return res.status(400).json({ error: 'notplaying', notPlaying: true });
    }
    if (!(await uriAllowedForVenue(venue_id, uri))) {
      return res.status(400).json({ error: 'blocked', blocked: true });
    }
    const user = await pool.query('SELECT credits FROM users WHERE id = $1', [req.session.userId]);
    if (!user.rows.length || user.rows[0].credits < 1) {
      return res.status(400).json({ error: 'No credits remaining' });
    }
    await pool.query('UPDATE users SET credits = credits - 1 WHERE id = $1', [req.session.userId]);
    const addedToSpotify = await addToSpotifyQueue(venue_id, uri);
    const id = Date.now();
    await pool.query(`
      INSERT INTO songs (id, track_id, name, artist, image, uri, venue_id, user_id, added_to_spotify, amount_paid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [id, track_id, track_name, artist, image, uri, venue_id, req.session.userId, addedToSpotify, 99]);
    const credits = await pool.query('SELECT credits FROM users WHERE id = $1', [req.session.userId]);
    const position = await pool.query(
      "SELECT COUNT(*) FROM songs WHERE venue_id = $1 AND status = 'queued'",
      [venue_id]
    );
    res.json({ success: true, position: parseInt(position.rows[0].count), addedToSpotify, creditsRemaining: credits.rows[0].credits });
    syncUserToSheet(req.session.userId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!data.access_token) return null;
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

// ── BAR MUSIC SETTINGS (explicit + genre filters) ──
// Spotify gives genres per artist, not per song, so a song is judged by its main artist.
// Each dashboard genre chip matches any Spotify genre containing one of these words.
const GENRE_KEYWORDS = {
  pop: ['pop'],
  hiphop: ['hip hop', 'rap', 'trap', 'drill', 'grime'],
  rnb: ['r&b', 'rnb'],
  rock: ['rock'],
  indie: ['indie'],
  electronic: ['electronic', 'edm', 'electro', 'dubstep', 'drum and bass', 'trance'],
  house: ['house'],
  techno: ['techno'],
  latin: ['latin', 'salsa', 'bachata', 'cumbia', 'merengue'],
  reggaeton: ['reggaeton', 'urbano latino', 'trap latino', 'dembow'],
  jazz: ['jazz'],
  soul: ['soul', 'funk', 'motown'],
  classical: ['classical', 'orchestra', 'baroque', 'opera'],
  country: ['country'],
  metal: ['metal'],
  punk: ['punk']
};

function cleanSettings(raw) {
  const s = raw || {};
  return {
    blockExplicit: !!s.blockExplicit,
    blockedGenres: Array.isArray(s.blockedGenres) ? s.blockedGenres.filter(g => GENRE_KEYWORDS[g]) : []
  };
}

async function getVenueSettings(venueId) {
  try {
    const r = await pool.query('SELECT settings FROM venues WHERE venue_id = $1', [venueId]);
    return cleanSettings(r.rows[0] && r.rows[0].settings);
  } catch (e) {
    return cleanSettings({});
  }
}

// Genre words are compared lowercased with dashes as spaces ("Hip-Hop" -> "hip hop").
const normGenre = g => String(g).toLowerCase().replace(/[-_]+/g, ' ').trim();

// Spotify's own artist genres. Spotify has been returning empty or vague genres for
// many artists, so this alone lets songs slip past the filter.
async function spotifyArtistGenres(artistId) {
  if (!artistId) return { genres: [], ok: true };
  try {
    const token = await getSpotifyToken();
    const r = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { genres: [], ok: false };
    const data = await r.json();
    return { genres: (data.genres || []).map(normGenre), ok: true };
  } catch (e) {
    return { genres: [], ok: false };
  }
}

// Last.fm artist tags: a second, much fuller genre source (e.g. John Summit -> house, tech house).
// Only the strong tags count (Last.fm scores 0-100), so one-off joke tags don't block songs.
// Needs LASTFM_API_KEY in Railway; without it, only Spotify's genres are used.
async function lastfmArtistTags(artistName) {
  const key = process.env.LASTFM_API_KEY;
  if (!key || !artistName) return { genres: [], ok: true };
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&autocorrect=1&format=json`
      + `&artist=${encodeURIComponent(artistName)}&api_key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { genres: [], ok: false };
    const data = await r.json();
    const tags = (data.toptags && data.toptags.tag) || [];
    return {
      genres: tags.filter(t => Number(t.count) >= 25).slice(0, 6).map(t => normGenre(t.name)),
      ok: !data.error || data.error === 6 // 6 = artist not found on Last.fm
    };
  } catch (e) {
    return { genres: [], ok: false };
  }
}

// Artist genres rarely change, so remember them for a day to keep API calls low.
// A lookup that failed isn't remembered, so it's retried on the next search.
const artistGenreCache = new Map();
async function getArtistGenres(artistId, artistName) {
  const cacheKey = artistId || `name:${artistName || ''}`;
  const hit = artistGenreCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.genres;
  const [sp, lf] = await Promise.all([spotifyArtistGenres(artistId), lastfmArtistTags(artistName)]);
  const genres = [...new Set([...sp.genres, ...lf.genres])];
  if (sp.ok && lf.ok) artistGenreCache.set(cacheKey, { genres, at: Date.now() });
  return genres;
}

// track needs { explicit, artistId, artistName }. Returns true if the bar's settings allow it.
async function trackAllowed(track, settings) {
  if (settings.blockExplicit && track.explicit) return false;
  if (!settings.blockedGenres.length) return true;
  const genres = await getArtistGenres(track.artistId, track.artistName);
  return !settings.blockedGenres.some(id =>
    GENRE_KEYWORDS[id].some(word => genres.some(g => g.includes(word)))
  );
}

// Server-side check before taking money or using a credit, so filtered songs
// can't be queued by bypassing the search screen.
async function uriAllowedForVenue(venueId, uri) {
  const settings = await getVenueSettings(venueId);
  if (!settings.blockExplicit && !settings.blockedGenres.length) return true;
  const trackId = String(uri || '').split(':').pop();
  if (!trackId) return false;
  try {
    const token = await getSpotifyToken();
    const r = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return true; // don't block a sale because Spotify hiccuped
    const t = await r.json();
    return trackAllowed({
      explicit: t.explicit,
      artistId: t.artists && t.artists[0] && t.artists[0].id,
      artistName: t.artists && t.artists[0] && t.artists[0].name
    }, settings);
  } catch (e) {
    return true;
  }
}

async function saveVenueToken(venueId, accessToken, refreshToken, expiresIn) {
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  await pool.query(`
    INSERT INTO venue_tokens (venue_id, access_token, refresh_token, expires_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (venue_id) DO UPDATE SET
      access_token = $2, refresh_token = $3, expires_at = $4, updated_at = NOW()
  `, [venueId, accessToken, refreshToken, expiresAt]);
}

async function getVenueToken(venueId) {
  try {
    const result = await pool.query('SELECT * FROM venue_tokens WHERE venue_id = $1', [venueId]);
    if (!result.rows.length) return null;
    const tokenData = result.rows[0];
    if (Date.now() < parseInt(tokenData.expires_at)) return tokenData.access_token;
    if (!tokenData.refresh_token) return null;
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenData.refresh_token })
    });
    const data = await r.json();
    if (!data.access_token) return null;
    await saveVenueToken(venueId, data.access_token, tokenData.refresh_token, data.expires_in);
    return data.access_token;
  } catch (e) {
    return null;
  }
}

async function addToSpotifyQueue(venueId, uri) {
  const token = await getVenueToken(venueId);
  if (!token) return false;
  try {
    const r = await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    return r.ok; // Spotify returns 200 or 204 depending on API version
  } catch (e) {
    return false;
  }
}

// Is the bar's Spotify actually playing right now? Patrons can only pay while it is,
// because Spotify refuses to queue songs when nothing is playing on the bar's device.
async function spotifyIsPlaying(venueId) {
  const token = await getVenueToken(venueId);
  if (!token) return false; // bar hasn't connected Spotify
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.status !== 200) return false; // 204 = no active device
    const data = await r.json();
    return !!(data && data.is_playing);
  } catch (e) {
    return true; // network hiccup talking to Spotify — don't block the sale; the retry below catches it
  }
}

// ── RETRY SONGS THAT DIDN'T REACH SPOTIFY ──
// If the music was paused between the patron paying and the song being sent,
// Spotify rejects it. Every 10 seconds, try again (oldest first) until it lands.
// Only looks at the last 3 hours so old test songs never get pushed by surprise.
async function retryPendingSpotify() {
  try {
    const pending = await pool.query(
      `SELECT id, venue_id, uri, name FROM songs
       WHERE status = 'queued' AND added_to_spotify IS NOT TRUE
         AND added_at > NOW() - INTERVAL '3 hours'
       ORDER BY added_at ASC`
    );
    const blockedVenues = new Set();
    for (const song of pending.rows) {
      if (blockedVenues.has(song.venue_id)) continue; // keep order: stop at first failure per bar
      const ok = await addToSpotifyQueue(song.venue_id, song.uri);
      if (ok) {
        await pool.query('UPDATE songs SET added_to_spotify = TRUE WHERE id = $1', [song.id]);
        console.log(`[spotify-retry] Sent "${song.name}" to Spotify at ${song.venue_id}`);
      } else {
        blockedVenues.add(song.venue_id);
      }
    }
  } catch (e) {
    console.error('[spotify-retry] Error:', e.message);
  }
}

// ── SERVER-SIDE AUTO-CLEAR ──
async function autoClearPlayed() {
  try {
    const venuesResult = await pool.query(
      "SELECT DISTINCT venue_id FROM songs WHERE status = 'queued'"
    );
    if (!venuesResult.rows.length) return;

    for (const { venue_id } of venuesResult.rows) {
      try {
        const token = await getVenueToken(venue_id);
        if (!token) continue;

        const queued = await pool.query(
          "SELECT uri, name FROM songs WHERE venue_id = $1 AND status = 'queued'",
          [venue_id]
        );
        if (!queued.rows.length) continue;

        const queuedUris = new Set(queued.rows.map(s => s.uri));

        const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (nowRes.status === 200) {
          const nowData = await nowRes.json();
          if (nowData && nowData.item && queuedUris.has(nowData.item.uri)) {
            const cleared = await pool.query(
              "UPDATE songs SET status = 'played', played_at = NOW() WHERE venue_id = $1 AND uri = $2 AND status = 'queued' RETURNING name",
              [venue_id, nowData.item.uri]
            );
            if (cleared.rowCount > 0) {
              console.log(`[auto-clear] Now playing: "${cleared.rows[0].name}" at ${venue_id}`);
            }
          }
        }

        const recentRes = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=5', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (recentRes.status === 200) {
          const recentData = await recentRes.json();
          if (recentData && recentData.items) {
            for (const item of recentData.items) {
              const uri = item.track.uri;
              if (queuedUris.has(uri)) {
                const cleared = await pool.query(
                  "UPDATE songs SET status = 'played', played_at = NOW() WHERE venue_id = $1 AND uri = $2 AND status = 'queued' RETURNING name",
                  [venue_id, uri]
                );
                if (cleared.rowCount > 0) {
                  console.log(`[auto-clear] Recently played: "${cleared.rows[0].name}" at ${venue_id}`);
                }
              }
            }
          }
        }
      } catch (e) {
        // Silently continue
      }
    }
  } catch (e) {
    console.error('[auto-clear] Error:', e.message);
  }
}

// ── SKIP SONGS THE BAR REMOVED ──
// Every 4 seconds, for bars with a removed song still in Spotify's queue: if that song is now
// playing, skip it. Each removal skips one play. Removals expire after 3 hours.
async function skipRemovedSongs() {
  try {
    await pool.query("DELETE FROM spotify_skips WHERE created_at < NOW() - INTERVAL '3 hours'");
    const venues = await pool.query('SELECT DISTINCT venue_id FROM spotify_skips');
    for (const { venue_id } of venues.rows) {
      try {
        const token = await getVenueToken(venue_id);
        if (!token) continue;
        const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (nowRes.status !== 200) continue;
        const now = await nowRes.json();
        const uri = now && now.item && now.item.uri;
        if (!uri) continue;
        const skip = await pool.query(
          'SELECT id, name FROM spotify_skips WHERE venue_id = $1 AND uri = $2 ORDER BY created_at LIMIT 1',
          [venue_id, uri]
        );
        if (!skip.rows.length) continue;
        const r = await fetch('https://api.spotify.com/v1/me/player/next', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }
        });
        if (r.ok) {
          await pool.query('DELETE FROM spotify_skips WHERE id = $1', [skip.rows[0].id]);
          console.log(`[skip-removed] Skipped removed song "${skip.rows[0].name}" at ${venue_id}`);
        }
      } catch (e) {
        // try again on the next round
      }
    }
  } catch (e) {
    console.error('[skip-removed] Error:', e.message);
  }
}

setTimeout(() => {
  skipRemovedSongs();
  setInterval(skipRemovedSongs, 4000);
  autoClearPlayed();
  setInterval(autoClearPlayed, 10000);
  retryPendingSpotify();
  setInterval(retryPendingSpotify, 10000);
}, 5000);

// ── OUTREACH AGENT (SCHEDULED) ──
// Runs every 6 hours rather than once a day on the dot — safe to do, because
// the agent's own decision logic already refuses to touch any one bar row
// twice on the same calendar day, so extra runs just find nothing new to do
// for rows already handled today. Running more often just means a server
// restart doesn't cost a full day's delay before outreach picks back up.
//
// Gated behind OUTREACH_LIVE so that setting up credentials and going live
// for real are two separate, deliberate steps — without this, the scheduled
// job would start sending real emails the moment all the credentials happened
// to be valid, even mid-setup/testing, with no explicit "I'm ready" moment.
// Set OUTREACH_LIVE=true in Railway only when you're ready for real sends.
async function runScheduledOutreach() {
  if (process.env.OUTREACH_LIVE !== 'true') {
    console.log('[outreach] Scheduled run skipped — OUTREACH_LIVE is not set to "true".');
    return;
  }
  try {
    const summary = await runOutreachAgent({ spreadsheetId: BAR_TRACKER_SHEET_ID });
    console.log('[outreach] Scheduled run complete:', JSON.stringify(summary));
  } catch (e) {
    console.error('[outreach] Scheduled run error:', e);
  }
}

setTimeout(() => {
  runScheduledOutreach();
  setInterval(runScheduledOutreach, 6 * 60 * 60 * 1000);
}, 60000);

// ── SPOTIFY CONNECT ──
// Only a bar logged in to its own dashboard, or the Zoros team (via a one-time link from /setup),
// can connect Spotify for a bar. The bar comes from the login or the link, never from the URL,
// and the callback only accepts a state this server handed out in the last 10 minutes.
// Kept in memory: a restart mid-connection just means clicking Connect again.
const spotifyStates = new Map();   // state  -> { venueId, returnTo, expires }
const spotifyTickets = new Map();  // ticket -> { venueId, expires }

function remember(map, value, minutes) {
  const now = Date.now();
  for (const [k, v] of map) if (v.expires < now) map.delete(k);
  const key = crypto.randomBytes(24).toString('hex');
  map.set(key, { ...value, expires: now + minutes * 60 * 1000 });
  return key;
}
function takeFresh(map, key) {
  const v = key && map.get(String(key));
  if (!v) return null;
  map.delete(String(key));
  return v.expires >= Date.now() ? v : null;
}

// Team-only: a link that connects Spotify for one bar, valid for 5 minutes and usable once
app.post('/api/admin/spotify-link', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const venueId = String((req.body && req.body.venueId) || '').trim();
  if (!/^[a-z0-9-]+$/.test(venueId)) return res.status(400).json({ error: 'Venue ID can only contain lowercase letters, numbers and hyphens' });
  if (await venueIsRemoved(venueId)) return res.status(400).json({ error: 'That bar has been removed' });
  res.json({ success: true, url: `/auth/spotify?ticket=${remember(spotifyTickets, { venueId }, 5)}` });
});

app.get('/auth/spotify', async (req, res) => {
  let venueId, returnTo;
  const ticket = takeFresh(spotifyTickets, req.query.ticket);
  if (ticket) {
    venueId = ticket.venueId; returnTo = 'setup';
  } else if (req.session.venueId && !(await venueIsRemoved(req.session.venueId))) {
    // A link for a different bar than the one logged in: don't quietly connect the logged-in bar
    const asked = req.query.venueId && String(req.query.venueId);
    if (asked && asked !== req.session.venueId) return res.redirect(`/bar?venue=${encodeURIComponent(asked)}`);
    venueId = req.session.venueId; returnTo = 'bar';
  } else {
    return res.redirect('/bar?error=login_required');
  }
  const scopes = 'user-modify-playback-state user-read-playback-state user-read-recently-played';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: `${process.env.BASE_URL}/auth/spotify/callback`,
    state: remember(spotifyStates, { venueId, returnTo }, 10)
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const pending = takeFresh(spotifyStates, req.query.state);
  if (!pending) return res.redirect('/bar?error=link_expired');
  const { venueId, returnTo } = pending;
  const fail = (err) => res.redirect(returnTo === 'setup' ? `/setup?error=${err}` : `/bar?error=${err}`);
  const { code } = req.query;
  if (!code) return fail('no_code');
  try {
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${process.env.BASE_URL}/auth/spotify/callback`
      })
    });
    const data = await r.json();
    if (!data.access_token) return fail('no_token');
    await saveVenueToken(venueId, data.access_token, data.refresh_token, data.expires_in);

    if (returnTo === 'setup') return res.redirect(`/setup?success=1&venueId=${encodeURIComponent(venueId)}`);

    // The bar started this from its logged-in dashboard. The callback can land on a different
    // address than where they logged in, so log them in here too.
    const venueResult = await pool.query('SELECT name FROM venues WHERE venue_id = $1', [venueId]);
    if (venueResult.rows.length) {
      req.session.venueId = venueId;
      req.session.venueName = venueResult.rows[0].name;
    }
    res.redirect(`/bar?spotify=connected`);
  } catch (e) {
    fail('auth_failed');
  }
});

app.get('/api/now-playing', async (req, res) => {
  const venueId = req.query.venueId || 'default';
  const token = await getVenueToken(venueId);
  if (!token) return res.json({ playing: false });
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.status === 204 || r.status === 404) return res.json({ playing: false });
    const data = await r.json();
    if (!data || !data.item) return res.json({ playing: false });
    res.json({
      playing: true,
      uri: data.item.uri,
      name: data.item.name,
      artist: data.item.artists.map(a => a.name).join(', '),
      image: data.item.album.images[1]?.url || data.item.album.images[0]?.url,
      progress_ms: data.progress_ms,
      duration_ms: data.item.duration_ms
    });
  } catch (e) {
    res.json({ playing: false });
  }
});

app.post('/api/queue/auto-clear', async (req, res) => {
  const { venueId, uri } = req.body;
  try {
    const result = await pool.query(
      "UPDATE songs SET status = 'played', played_at = NOW() WHERE venue_id = $1 AND uri = $2 AND status = 'queued' RETURNING *",
      [venueId, uri]
    );
    res.json({ cleared: result.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/venue/status', async (req, res) => {
  const venueId = req.query.venueId || req.session.venueId || 'default';
  const token = await getVenueToken(venueId);
  if (!token) return res.json({ connected: false });
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.status === 200) {
      const data = await r.json();
      return res.json({ connected: true, device: data.device?.name, playing: data.is_playing });
    }
    return res.json({ connected: true, device: null, playing: false });
  } catch (e) {
    return res.json({ connected: true, device: null });
  }
});

app.get('/api/debug', async (req, res) => {
  try {
    const result = await pool.query('SELECT venue_id FROM venue_tokens');
    res.json({
      hasSpotifyId: !!process.env.SPOTIFY_CLIENT_ID,
      hasSpotifySecret: !!process.env.SPOTIFY_CLIENT_SECRET,
      hasStripe: !!process.env.STRIPE_SECRET_KEY,
      hasBaseUrl: !!process.env.BASE_URL,
      hasDatabase: !!process.env.DATABASE_URL,
      hasGmailAddress: !!process.env.GMAIL_ADDRESS,
      hasGmailAppPassword: !!process.env.GMAIL_APP_PASSWORD,
      hasGoogleServiceAccountKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.BASE_URL,
      connectedVenues: result.rows.map(r => r.venue_id)
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Does this song look like what the guest typed? Every meaningful search word must appear
// in the song title or artist names ("the", "feat" etc. ignored, accents and punctuation ignored).
const SEARCH_FILLER = new Set(['the', 'a', 'an', 'feat', 'ft', 'and', 'el', 'la', 'los', 'las', 'de', 'del', 'le', 'les', 'het', 'een', 'und', 'der', 'die', 'das']);
const normSearch = str => String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function matchesSearch(text, q) {
  const words = normSearch(q).split(' ').filter(w => w && !SEARCH_FILLER.has(w));
  if (!words.length) return true;
  const hay = ` ${normSearch(text)} `;
  return words.every(w => hay.includes(` ${w}`));
}

// Which hidden songs should the guest be told about?
// - Searched an artist the bar blocks (Drake): the hidden songs by that artist.
// - Searched a song title, and none of the shown songs are by an artist matching the search: hidden title matches.
// - Searched an allowed artist (Oasis): nothing, even if an unrelated song called "Oasis" was hidden.
function hiddenWorthMentioning(removed, shown, q) {
  if (!shown.length) return removed; // everything hidden: always explain
  const byArtist = t => matchesSearch(t.artistName || t.artist, q);
  const artistHits = removed.filter(byArtist);
  if (artistHits.length) return artistHits;
  if (shown.some(byArtist)) return [];
  return removed.filter(t => matchesSearch(t.name, q));
}

app.get('/api/search', async (req, res) => {
  try {
    const { q, venueId } = req.query;
    if (!q) return res.json({ tracks: [] });
    const token = await getSpotifyToken();
    if (!token) return res.json({ tracks: [], error: 'No Spotify token' });
    const settings = venueId ? await getVenueSettings(venueId) : cleanSettings({});
    const filtering = settings.blockExplicit || settings.blockedGenres.length > 0;

    // Spotify caps search at 10 results per call. When the bar filters songs out,
    // grab a second page so patrons still see a decent list.
    const fetchPage = async (offset) => {
      const r = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10&offset=${offset}&market=DE`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await r.json();
      return (data.tracks && data.tracks.items) || null;
    };
    const pages = await Promise.all(filtering ? [fetchPage(0), fetchPage(10)] : [fetchPage(0)]);
    if (!pages[0]) return res.json({ tracks: [], error: 'Spotify API error' });
    const items = pages.flat().filter(Boolean);

    let tracks = items.map(t => ({
      id: t.id,
      name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      artistId: t.artists[0] && t.artists[0].id,
      artistName: t.artists[0] && t.artists[0].name,
      explicit: !!t.explicit,
      album: t.album.name,
      image: t.album.images[1]?.url || t.album.images[0]?.url,
      duration_ms: t.duration_ms,
      uri: t.uri,
      preview_url: t.preview_url
    }));

    let hidden = 0, hiddenExplicit = 0;
    if (filtering) {
      const allowed = await Promise.all(tracks.map(t => trackAllowed(t, settings)));
      // Only tell guests about hidden songs that are what they searched for. Searching "the beatles"
      // can pull in a house remix by someone else; hiding that shouldn't show the bar's-settings message.
      let removed = tracks.filter((t, i) => !allowed[i]);
      tracks = tracks.filter((t, i) => allowed[i]);
      removed = hiddenWorthMentioning(removed, tracks, q);
      hidden = removed.length;
      // How many were hidden for explicit lyrics (the rest were the genre filter), so guests get the right reason
      hiddenExplicit = removed.filter(t => settings.blockExplicit && t.explicit).length;
    }
    res.json({ tracks: tracks.slice(0, 10), hidden, hiddenExplicit, hiddenGenre: hidden - hiddenExplicit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const SONG_PRICE = 99; // cents, EUR

// ── AUTOMATIC SPLIT (STRIPE CONNECT) ──
// The bar gets BAR_SHARE (75%) of each payment after the Stripe fee; Zoros keeps the rest.
// Zoros's share has to be fixed when the checkout is created, before Stripe knows the exact
// fee, so the fee is estimated at Stripe's standard European card rate (1.5% + €0.25). For a
// non-European card the real fee is a little higher and Zoros absorbs the difference.
// Payments are made on behalf of the bar's connected account (needed because the Zoros
// platform account and the bar are in different regions), and Stripe moves the bar's share to it.
const estimatedStripeFee = amount => Math.round(amount * 0.015) + 25;
const barShareOf = (amount, fee) => Math.round((amount - fee) * BAR_SHARE);

// Is this connected account ready to be paid? Cached for 10 minutes so checkouts stay fast.
const connectReady = new Map(); // acct -> { ok, reason, at }
async function connectedAccountStatus(acct, { fresh = false } = {}) {
  const hit = connectReady.get(acct);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  let status;
  try {
    const a = await stripe.accounts.retrieve(acct);
    const caps = a.capabilities || {};
    const ok = !!a.charges_enabled && caps.card_payments === 'active' && caps.transfers === 'active';
    status = { ok, reason: ok ? 'Enabled' : 'Waiting on the bar to finish Stripe onboarding' };
  } catch (e) {
    status = { ok: false, reason: `Stripe couldn't find or read this account (${e.message})` };
  }
  status.at = Date.now();
  connectReady.set(acct, status);
  return status;
}

// Extra Checkout settings that split this payment with the bar, or null to keep today's
// behaviour (all to Zoros, bar paid by hand from the dashboard's "Owed")
async function splitForVenue(venueId, amount) {
  try {
    const r = await pool.query('SELECT stripe_account_id FROM venues WHERE venue_id = $1', [venueId]);
    const acct = r.rows[0] && r.rows[0].stripe_account_id;
    if (!acct || !(await connectedAccountStatus(acct)).ok) return null;
    const barAmount = barShareOf(amount, estimatedStripeFee(amount));
    return {
      acct, barAmount,
      paymentIntentData: { on_behalf_of: acct, transfer_data: { destination: acct }, application_fee_amount: amount - barAmount }
    };
  } catch (e) {
    console.error('[connect] split lookup failed, paying Zoros only:', e.message);
    return null;
  }
}

// Creates the Checkout session, split with the bar when possible. If Stripe refuses the split,
// the payment is created without it so the patron can always pay.
async function createCheckout(params, venueId, amount) {
  const split = await splitForVenue(venueId, amount);
  if (split) {
    try {
      return await stripe.checkout.sessions.create({
        ...params,
        payment_intent_data: split.paymentIntentData,
        metadata: { ...params.metadata, splitTo: split.acct, barAmount: String(split.barAmount) }
      });
    } catch (e) {
      console.error(`[connect] split refused for ${venueId}, paying Zoros only:`, e.message);
    }
  }
  return stripe.checkout.sessions.create(params);
}

// Show Stripe's checkout page in the language the patron picked in Zoros
function stripeLocale(lang) {
  return ['en', 'es', 'nl', 'fr'].includes(lang) ? lang : 'auto';
}

app.post('/api/create-payment', async (req, res) => {
  try {
    const { trackId, trackName, artist, image, uri, venueId = 'default', src, lang } = req.body;
    const price = SONG_PRICE; // set server-side so a patron can't edit the request to pay less
    if (!(await venueIsActive(venueId))) {
      return res.status(400).json({ error: 'off', off: true });
    }
    if (!(await spotifyIsPlaying(venueId))) {
      return res.status(400).json({ error: 'notplaying', notPlaying: true });
    }
    if (!(await uriAllowedForVenue(venueId, uri))) {
      return res.status(400).json({ error: 'blocked', blocked: true });
    }
    const session = await createCheckout({
      locale: stripeLocale(lang),
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `♫ ${trackName}`,
            description: `by ${artist}`,
            images: image ? [image] : []
          },
          unit_amount: price
        },
        quantity: 1
      }],
      mode: 'payment',
      metadata: {
        trackId: String(trackId || ''),
        trackName: String(trackName || '').slice(0, 480),
        artist: String(artist || '').slice(0, 480),
        image: String(image || '').slice(0, 480),
        uri: String(uri || ''),
        venueId: String(venueId),
        src: cleanSrc(src) || ''
      },
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&track_id=${trackId}&track_name=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artist)}&image=${encodeURIComponent(image || '')}&uri=${encodeURIComponent(uri)}&venue_id=${venueId}`,
      cancel_url: `${process.env.BASE_URL}?venue=${venueId}`
    }, venueId, price);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/queue/add', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'Missing session' });
    const stripeSession = await stripe.checkout.sessions.retrieve(session_id);
    if (stripeSession.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }
    // Song details come from the Stripe session (set when payment was created), not the URL,
    // so a paid session can't be swapped for a different song or venue.
    const m = stripeSession.metadata || {};
    const b = req.body;
    const track_id = m.trackId || b.track_id;
    const track_name = m.trackName || b.track_name;
    const artist = m.artist || b.artist;
    const image = m.image || b.image;
    const uri = m.uri || b.uri;
    const venue_id = m.venueId || b.venue_id || 'default';

    const countQueued = async () => parseInt((await pool.query(
      "SELECT COUNT(*) FROM songs WHERE venue_id = $1 AND status = 'queued'", [venue_id]
    )).rows[0].count);

    // Already honored this payment (e.g. patron refreshed the success page) — don't queue again
    if (!(await claimPayment(session_id, 'song', stripeSession))) {
      return res.json({ success: true, alreadyProcessed: true, position: await countQueued() });
    }

    const addedToSpotify = await addToSpotifyQueue(venue_id, uri);
    const id = Date.now();
    await pool.query(`
      INSERT INTO songs (id, track_id, name, artist, image, uri, venue_id, added_to_spotify, amount_paid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [id, track_id, track_name, artist, image, uri, venue_id, addedToSpotify, stripeSession.amount_total || 99]);
    const position = await pool.query(
      "SELECT COUNT(*) FROM songs WHERE venue_id = $1 AND status = 'queued'",
      [venue_id]
    );
    res.json({ success: true, position: parseInt(position.rows[0].count), addedToSpotify });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WHAT ACTUALLY PLAYS NEXT (bar's own queued songs + Zoros requests) ──
// Spotify plays songs the bartender queued before Zoros requests, so guests should see them.
// Spotify's queue list doesn't say which songs were queued by hand and which are just the
// playlist continuing, but Zoros songs always go to the end of the hand-queued part. So
// everything up to the last Zoros song is the real "up next" line; after that is the playlist.
// Remembered for 10s per bar, since every guest's phone asks every 10s.
const upcomingCache = new Map();
async function getUpcoming(venueId, zorosRows) {
  if (!zorosRows.length) return [];
  const hit = upcomingCache.get(venueId);
  if (hit && Date.now() - hit.at < 10000) return hit.list;
  const token = await getVenueToken(venueId);
  if (!token) return null;
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player/queue', { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) return null;
    const data = await r.json();
    const spotifyQueue = (data.queue || []).filter(t => t && t.uri);

    // Zoros songs already handed to Spotify, matched by song (a song can be requested twice)
    const sent = zorosRows.filter(s => s.added_to_spotify);
    const remaining = {};
    sent.forEach(s => { remaining[s.uri] = (remaining[s.uri] || 0) + 1; });
    let lastZoros = -1, left = sent.length;
    for (let i = 0; i < spotifyQueue.length && left > 0; i++) {
      if (remaining[spotifyQueue[i].uri] > 0) { remaining[spotifyQueue[i].uri]--; left--; lastZoros = i; }
    }

    const counts = {};
    sent.forEach(s => { counts[s.uri] = (counts[s.uri] || 0) + 1; });
    const list = spotifyQueue.slice(0, lastZoros + 1).map(t => {
      const zoros = counts[t.uri] > 0;
      if (zoros) counts[t.uri]--;
      return {
        name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        image: (t.album && t.album.images && (t.album.images[2] || t.album.images[0]) || {}).url || '',
        source: zoros ? 'zoros' : 'bar'
      };
    });
    // Requests Spotify hasn't got yet (music paused) or that didn't show in its list go last
    zorosRows.filter(s => !s.added_to_spotify || counts[s.uri] > 0).forEach(s => {
      if (s.added_to_spotify) counts[s.uri]--;
      list.push({ name: s.name, artist: s.artist, image: s.image, source: 'zoros' });
    });
    upcomingCache.set(venueId, { list, at: Date.now() });
    return list;
  } catch (e) {
    return null;
  }
}

app.get('/api/queue', async (req, res) => {
  const venueId = req.query.venueId || 'default';
  try {
    const queue = await pool.query(
      "SELECT * FROM songs WHERE venue_id = $1 AND status = 'queued' ORDER BY added_at ASC",
      [venueId]
    );
    const played = await pool.query(
      "SELECT * FROM songs WHERE venue_id = $1 AND status = 'played' ORDER BY played_at DESC LIMIT 5",
      [venueId]
    );
    const upcoming = await getUpcoming(venueId, queue.rows);
    res.json({
      queue: queue.rows.map(s => ({ id: s.id, name: s.name, artist: s.artist, image: s.image, uri: s.uri, venueId: s.venue_id, addedAt: s.added_at })),
      played: played.rows.map(s => ({ id: s.id, name: s.name, artist: s.artist, image: s.image, uri: s.uri, venueId: s.venue_id, playedAt: s.played_at })),
      upcoming // null if Spotify couldn't be asked; the app then shows just the Zoros requests
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/queue/played/:id', requireVenueAuth, async (req, res) => {
  try {
    await pool.query("UPDATE songs SET status = 'played', played_at = NOW() WHERE id = $1 AND venue_id = $2", [req.params.id, req.session.venueId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Only the logged-in bar can remove songs from its own queue. If the song already went to
// Spotify (which can't delete from its queue), it's also marked to be skipped when it starts.
app.post('/api/queue/skip/:id', requireVenueAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "DELETE FROM songs WHERE id = $1 AND venue_id = $2 AND status = 'queued' RETURNING uri, name, added_to_spotify",
      [req.params.id, req.session.venueId]
    );
    const song = r.rows[0];
    const willSkip = !!(song && song.added_to_spotify && song.uri);
    if (willSkip) {
      await pool.query('INSERT INTO spotify_skips (venue_id, uri, name) VALUES ($1, $2, $3)', [req.session.venueId, song.uri, song.name]);
    }
    res.json({ success: true, willSkip });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/bundle-success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bundle-success.html')));
app.get('/bar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bar.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoros running on port ${PORT}`));
