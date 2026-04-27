require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
        added_at TIMESTAMP DEFAULT NOW(),
        status VARCHAR(50) DEFAULT 'queued',
        played_at TIMESTAMP,
        added_to_spotify BOOLEAN DEFAULT FALSE
      )
    `);
    console.log('Database initialized');
  } catch (e) {
    console.error('DB init error:', e);
  }
}

initDB();

let spotifyToken = null;
let tokenExpiry = 0;

// ── SPOTIFY CLIENT CREDENTIALS (for search) ──
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

// ── SAVE VENUE TOKEN TO DB ──
async function saveVenueToken(venueId, accessToken, refreshToken, expiresIn) {
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  await pool.query(`
    INSERT INTO venue_tokens (venue_id, access_token, refresh_token, expires_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (venue_id) DO UPDATE SET
      access_token = $2,
      refresh_token = $3,
      expires_at = $4,
      updated_at = NOW()
  `, [venueId, accessToken, refreshToken, expiresAt]);
}

// ── GET VENUE TOKEN FROM DB ──
async function getVenueToken(venueId) {
  try {
    const result = await pool.query('SELECT * FROM venue_tokens WHERE venue_id = $1', [venueId]);
    if (!result.rows.length) return null;
    const tokenData = result.rows[0];
    if (Date.now() < parseInt(tokenData.expires_at)) {
      return tokenData.access_token;
    }
    if (!tokenData.refresh_token) return null;
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token
      })
    });
    const data = await r.json();
    if (!data.access_token) return null;
    await saveVenueToken(venueId, data.access_token, tokenData.refresh_token, data.expires_in);
    return data.access_token;
  } catch (e) {
    console.error('Get venue token error:', e);
    return null;
  }
}

// ── SPOTIFY OAUTH ──
app.get('/auth/spotify', (req, res) => {
  const venueId = req.query.venueId || 'default';
  const scopes = 'user-modify-playback-state user-read-playback-state';
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
  if (!code) return res.redirect('/setup?error=no_code');
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
    if (!data.access_token) return res.redirect('/setup?error=no_token');
    await saveVenueToken(venueId, data.access_token, data.refresh_token, data.expires_in);
    res.redirect(`/setup?success=true&venueId=${venueId}`);
  } catch (e) {
    console.error('Auth callback error:', e);
    res.redirect('/setup?error=auth_failed');
  }
});

// ── ADD SONG TO SPOTIFY QUEUE ──
async function addToSpotifyQueue(venueId, uri) {
  const token = await getVenueToken(venueId);
  if (!token) {
    console.log('No venue token for', venueId);
    return false;
  }
  try {
    const r = await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Spotify queue response:', r.status);
    return r.status === 204;
  } catch (e) {
    console.error('Spotify queue error:', e);
    return false;
  }
}

// ── NOW PLAYING ──
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

// ── AUTO CLEAR PLAYED SONGS ──
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

// ── VENUE STATUS ──
app.get('/api/venue/status', async (req, res) => {
  const venueId = req.query.venueId || 'default';
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

// ── DEBUG ──
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

// ── SEARCH ──
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

// ── CREATE PAYMENT ──
app.post('/api/create-payment', async (req, res) => {
  try {
    const { trackId, trackName, artist, image, uri, price = 100, venueId = 'default' } = req.body;
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

// ── ADD TO QUEUE AFTER PAYMENT ──
app.post('/api/queue/add', async (req, res) => {
  try {
    const { session_id, track_id, track_name, artist, image, uri, venue_id = 'default' } = req.body;
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }
    const addedToSpotify = await addToSpotifyQueue(venue_id, uri);
    const id = Date.now();
    await pool.query(`
      INSERT INTO songs (id, track_id, name, artist, image, uri, venue_id, added_to_spotify)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, track_id, track_name, artist, image, uri, venue_id, addedToSpotify]);
    const position = await pool.query(
      "SELECT COUNT(*) FROM songs WHERE venue_id = $1 AND status = 'queued'",
      [venue_id]
    );
    res.json({ success: true, position: parseInt(position.rows[0].count), addedToSpotify });
  } catch (e) {
    console.error('Queue add error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET QUEUE ──
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
      queue: queue.rows.map(s => ({
        id: s.id, name: s.name, artist: s.artist, image: s.image, uri: s.uri, venueId: s.venue_id, addedAt: s.added_at
      })),
      played: played.rows.map(s => ({
        id: s.id, name: s.name, artist: s.artist, image: s.image, uri: s.uri, venueId: s.venue_id, playedAt: s.played_at
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MARK AS PLAYED ──
app.post('/api/queue/played/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query(
      "UPDATE songs SET status = 'played', played_at = NOW() WHERE id = $1",
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SKIP ──
app.post('/api/queue/skip/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query("DELETE FROM songs WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PAGES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/bar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bar.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Komos running on port ${PORT}`));
