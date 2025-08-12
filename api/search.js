// /api/search.js — Vercel Serverless Function (Node runtime)

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // ---- Read JSON body robustly (Vercel Node functions don't always parse it) ----
  const payload = await readJSON(req);
  const subject  = (payload.subject  || '').trim();
  const industry = (payload.industry || '').trim();
  const location = (payload.location || '').trim();

  // Build a human-readable query string from inputs
  const queryUsed = [
    (subject ? subject : ''),
    (industry ? industry : ''),
    (location ? `in ${location}` : '')
  ].filter(Boolean).join(' ').trim() || 'manufacturer';

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // ---- Scoring helpers (kept simple) ----
  const tokens = (s) => String(s || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const containsAll = (text, q) => {
    if (!q || !q.trim()) return true;
    const t = String(text || '').toLowerCase();
    return tokens(q).every(tok => t.includes(tok));
  };
  const score = (c) => {
    const combined = [c.name, c.description, c.address, c.website].join(' ');
    let s = 0;
    if (containsAll(combined, subject))  s += 50;
    if (containsAll(combined, industry)) s += 30;
    if (containsAll(c.address || '', location)) s += 20;
    return Math.max(10, Math.min(100, s || 10));
  };

  // ---- Mock fallback (if no key or API fails) ----
  const MOCK = [
    {
      name: 'AI Logistics Pty Ltd',
      website: 'https://ailogistics.example',
      address: 'CBD, Sydney',
      revenueRange: '$10M–$50M',
      description: 'AI supply chain solutions for manufacturers',
    },
    {
      name: 'Smart Manufacturing AI',
      website: 'https://smaiai.example',
      address: 'North Sydney',
      revenueRange: '$5M–$25M',
      description: 'AI for manufacturing optimisation',
    },
  ];

  if (!apiKey) {
    const companies = MOCK.map(c => ({ ...c, leadScore: score(c) }));
    return res.status(200).json({ mode: 'mock', queryUsed, companies });
  }

  try {
    // Google Places Text Search v1
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const body = { textQuery: queryUsed, maxResultCount: 10, languageCode: 'en' };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.formattedAddress,places.types'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      // Fallback to mock on API error
      const companies = MOCK.map(c => ({ ...c, leadScore: score(c) }));
      return res.status(200).json({ mode: 'mock', queryUsed, note: `fallback (${r.status})`, companies });
    }

    const data = await r.json();
    const companies = (data.places || []).map(p => {
      const c = {
        name: p.displayName?.text || '—',
        website: p.websiteUri || '',
        address: p.formattedAddress || '',
        description: `${subject} ${industry}`.trim()
      };
      c.leadScore = score(c);
      return c;
    });

    return res.status(200).json({ mode: 'live', queryUsed, companies });
  } catch (err) {
    console.error('Search error:', err);
    const companies = MOCK.map(c => ({ ...c, leadScore: score(c) }));
    return res.status(200).json({ mode: 'mock', queryUsed, note: 'fallback due to exception', companies });
  }
}

// Helper: read JSON from Node request stream safely
async function readJSON(req) {
  // If a body object already exists and looks parsed, use it.
  if (req.body && typeof req.body === 'object') return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
