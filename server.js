// v5
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const app = express();
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
  secret: process.env.SESSION_SECRET || 'komos-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

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
    if (!result.rows.length) return res.json({ loggedIn: false });
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

// ── VENUE ACTIVE STATUS (for patron app) ──
app.get('/api/venue/active', async (req, res) => {
  const venueId = req.query.venueId || 'default';
  try {
    const result = await pool.query('SELECT is_active FROM venues WHERE venue_id = $1', [venueId]);
    if (!result.rows.length) return res.json({ isActive: true });
    res.json({ isActive: result.rows[0].is_active });
  } catch (e) {
    res.json({ isActive: true });
  }
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
app.post('/api/admin/create-venue', async (req, res) => {
  const { adminKey, name, city, venueId, email, password } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const existing = await pool.query('SELECT id FROM venues WHERE email = $1 OR venue_id = $2', [email.toLowerCase(), venueId]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email or venue ID already exists' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO venues (name, city, venue_id, email, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, city, venue_id',
      [name, city, venueId, email.toLowerCase(), hash]
    );
    res.json({ success: true, venue: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BUNDLE PAYMENT ──
app.post('/api/create-bundle-payment', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Must be logged in to buy bundles' });
  const bundles = {
    single: { credits: 1, price: 99, label: '1 Song' },
    five: { credits: 5, price: 399, label: '5 Songs' },
    ten: { credits: 10, price: 599, label: '10 Songs' }
  };
  const { bundleType, venueId = 'default' } = req.body;
  const bundle = bundles[bundleType];
  if (!bundle) return res.status(400).json({ error: 'Invalid bundle' });
  try {
    const session = await stripe.checkout.sessions.create({
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
      success_url: `${process.env.BASE_URL}/bundle-success?session_id={CHECKOUT_SESSION_ID}&bundle=${bundleType}&venue_id=${venueId}`,
      cancel_url: `${process.env.BASE_URL}?venue=${venueId}`
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BUNDLE SUCCESS ──
app.post('/api/bundle/confirm', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const bundles = { single: 1, five: 5, ten: 10 };
  const { session_id, bundle } = req.body;
  const credits = bundles[bundle];
  if (!credits) return res.status(400).json({ error: 'Invalid bundle' });
  try {
    const stripeSession = await stripe.checkout.sessions.retrieve(session_id);
    if (stripeSession.payment_status !== 'paid') return res.status(400).json({ error: 'Payment not confirmed' });
    const result = await pool.query(
      'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
      [credits, req.session.userId]
    );
    res.json({ success: true, credits: result.rows[0].credits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── USE CREDIT TO QUEUE SONG ──
app.post('/api/queue/use-credit', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { track_id, track_name, artist, image, uri, venue_id = 'default' } = req.body;
  try {
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
    return r.status === 204;
  } catch (e) {
    return false;
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

setTimeout(() => {
  autoClearPlayed();
  setInterval(autoClearPlayed, 10000);
}, 5000);

app.get('/auth/spotify', (req, res) => {
  const venueId = req.query.venueId || req.session.venueId || 'default';
  const scopes = 'user-modify-playback-state user-read-playback-state user-read-recently-played';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: `${process.env.BASE_URL}/auth/spotify/callback`,
    state: venueId
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state: venueId } = req.query;
  if (!code) return res.redirect('/bar?error=no_code');
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
    if (!data.access_token) return res.redirect('/bar?error=no_token');
    await saveVenueToken(venueId, data.access_token, data.refresh_token, data.expires_in);

    // Restore venue session
    const venueResult = await pool.query('SELECT name FROM venues WHERE venue_id = $1', [venueId]);
    if (venueResult.rows.length) {
      req.session.venueId = venueId;
      req.session.venueName = venueResult.rows[0].name;
    }

    res.redirect(`/bar?spotify=connected`);
  } catch (e) {
    res.redirect('/bar?error=auth_failed');
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
      baseUrl: process.env.BASE_URL,
      connectedVenues: result.rows.map(r => r.venue_id)
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ tracks: [] });
    const token = await getSpotifyToken();
    if (!token) return res.json({ tracks: [], error: 'No Spotify token' });
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8&market=DE`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    if (!data.tracks) return res.json({ tracks: [], error: 'Spotify API error' });
    const tracks = data.tracks.items.map(t => ({
      id: t.id,
      name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      album: t.album.name,
      image: t.album.images[1]?.url || t.album.images[0]?.url,
      duration_ms: t.duration_ms,
      uri: t.uri,
      preview_url: t.preview_url
    }));
    res.json({ tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/create-payment', async (req, res) => {
  try {
    const { trackId, trackName, artist, image, uri, price = 99, venueId = 'default' } = req.body;
    const session = await stripe.checkout.sessions.create({
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
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&track_id=${trackId}&track_name=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artist)}&image=${encodeURIComponent(image || '')}&uri=${encodeURIComponent(uri)}&venue_id=${venueId}`,
      cancel_url: `${process.env.BASE_URL}?venue=${venueId}`
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/queue/add', async (req, res) => {
  try {
    const { session_id, track_id, track_name, artist, image, uri, venue_id = 'default' } = req.body;
    const stripeSession = await stripe.checkout.sessions.retrieve(session_id);
    if (stripeSession.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }
    const addedToSpotify = await addToSpotifyQueue(venue_id, uri);
    const id = Date.now();
    await pool.query(`
      INSERT INTO songs (id, track_id, name, artist, image, uri, venue_id, added_to_spotify, amount_paid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [id, track_id, track_name, artist, image, uri, venue_id, addedToSpotify, 99]);
    const position = await pool.query(
      "SELECT COUNT(*) FROM songs WHERE venue_id = $1 AND status = 'queued'",
      [venue_id]
    );
    res.json({ success: true, position: parseInt(position.rows[0].count), addedToSpotify });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    res.json({
      queue: queue.rows.map(s => ({ id: s.id, name: s.name, artist: s.artist, image: s.image, uri: s.uri, venueId: s.venue_id, addedAt: s.added_at })),
      played: played.rows.map(s => ({ id: s.id, name: s.name, artist: s.artist, image: s.image, uri: s.uri, venueId: s.venue_id, playedAt: s.played_at }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/queue/played/:id', async (req, res) => {
  try {
    await pool.query("UPDATE songs SET status = 'played', played_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/queue/skip/:id', async (req, res) => {
  try {
    await pool.query("DELETE FROM songs WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/bundle-success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bundle-success.html')));
app.get('/bar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bar.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoros running on port ${PORT}`));
