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

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ tracks: [] });
    const token = await getSpotifyToken();
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8&market=NL`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    const tracks = (data.tracks?.items || []).map(t => ({
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
    const { trackId, trackName, artist, image, uri, price = 100 } = req.body;
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
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&track_id=${trackId}&track_name=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artist)}&image=${encodeURIComponent(image || '')}&uri=${encodeURIComponent(uri)}`,
      cancel_url: `${process.env.BASE_URL}`
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/queue/add', async (req, res) => {
  try {
    const { session_id, track_id, track_name, artist, image, uri } = req.body;
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }
    const song = {
      id: Date.now(),
      trackId: track_id,
      name: track_name,
      artist,
      image,
      uri,
      addedAt: new Date().toISOString(),
      status: 'queued'
    };
    queue.push(song);
    res.json({ success: true, position: queue.length, song });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/queue', (req, res) => {
  res.json({ queue, played: playedSongs.slice(-5) });
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/bar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bar.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Komos running on port ${PORT}`));
