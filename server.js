require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let queue = [];
let playedSongs = [];
let spotifyToken = null;
let tokenExpiry = 0;

// Venue Spotify access tokens (venueId -> token data)
let venueTokens = {};

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

// ── SPOTIFY OAUTH (for venue playback control) ──
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
    venueTokens[venueId] = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000
    };
    res.redirect(`/setup?success=true&venueId=${venueId}`);
  } catch (e) {
    res.redirect('/setup?error=auth_failed');
  }
});

// ── REFRESH VENUE TOKEN ──
async function getVenueToken(venueId) {
  const tokenData = venueTokens[venueId];
  if (!tokenData) return null;
  if (Date.now() < tokenData.expiresAt) return tokenData.accessToken;
  try {
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refreshToken
      })
    });
    const data = await r.json();
    if (!data.access_token) return null;
    venueTokens[venueId] = {
      ...tokenData,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000
    };
    return data.access_token;
  } catch (e) {
    return null;
  }
}

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

// ── CHECK VENUE SPOTIFY STATUS ──
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
app.get('/api/debug', (req, res) => {
  res.json({
    hasSpotifyId: !!process.env.SPOTIFY_CLIENT_ID,
    hasSpotifySecret: !!process.env.SPOTIFY_CLIENT_SECRET,
    hasStripe: !!process.env.STRIPE_SECRET_KEY,
    hasBaseUrl: !!process.env.BASE_URL,
    baseUrl: process.env.BASE_URL,
    connectedVenues: Object.keys(venueTokens)
  });
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
      cancel_url: `${process.env.BASE_URL}`
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
    const song = {
      id: Date.now(),
      trackId: track_id,
      name: track_name,
      artist,
      image,
      uri,
      venueId: venue_id,
      addedAt: new Date().toISOString(),
      status: 'queued',
      addedToSpotify
    };
    queue.push(song);
    res.json({ success: true, position: queue.filter(s => s.venueId === venue_id).length, song, addedToSpotify });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── QUEUE ──
app.get('/api/queue', (req, res) => {
  const venueId = req.query.venueId || 'default';
  const venueQueue = queue.filter(s => s.venueId === venueId);
  const venuePlayed = playedSongs.filter(s => s.venueId === venueId).slice(-5);
  res.json({ queue: venueQueue, played: venuePlayed });
});

app.post('/api/queue/played/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = queue.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [song] = queue.splice(idx, 1);
  song.status = 'played';
  song.playedAt = new Date().toISOString();
  playedSongs.push(song);
  res.json({ success: true });
});

app.post('/api/queue/skip/:id', (req, res) => {
  const id = parseInt(req.params.id);
  queue = queue.filter(s => s.id !== id);
  res.json({ success: true });
});

// ── PAGES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/bar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bar.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Komos running on port ${PORT}`));
