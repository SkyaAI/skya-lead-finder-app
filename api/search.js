// /api/search.js - Vercel serverless function
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { subject = '', industry = '', location = '' } = req.body || {};
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // Simple mock fallback when no API key is set
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

  // Lead score heuristic
  const tokens = (s) => String(s || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const containsAll = (text, q) => {
    if (!q || !q.trim()) return true;
    const t = String(text || '').toLowerCase();
    return tokens(q).every((tok) => t.includes(tok));
  };
  const score = (c) => {
    const combined = [c.name, c.description, c.address, c.website].join(' ');
    let s = 0;
    if (containsAll(combined, subject)) s += 50;
    if (containsAll(combined, industry)) s += 30;
    if (containsAll(c.address || '', location)) s += 20;
    return Math.max(10, Math.min(100, s || 10));
  };

  // If no key, return mock
  if (!apiKey) {
    const companies = MOCK.map((c) => ({ ...c, leadScore: score(c) }));
    return res.status(200).json({ mode: 'mock', companies });
  }

  // Query Google Places Text Search (Places API v1)
  try {
    const textQuery =
      (industry && location) ? `${industry} in ${location}` :
      (industry || subject || 'manufacturer') + (location ? ` in ${location}` : '');

    const url = 'https://places.googleapis.com/v1/places:searchText';
    const body = {
      textQuery,
      maxResultCount: 10,
      languageCode: 'en',
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Only request what we render
        'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.formattedAddress',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const t = await r.text();
      console.error('Places API error:', r.status, t);
      // fall back to mock if Places fails
      const companies = MOCK.map((c) => ({ ...c, leadScore: score(c) }));
      return res.status(200).json({ mode: 'mock', companies, note: 'fallback due to API error' });
    }

    const data = await r.json();
    const companies = (data.places || []).map((p) => {
      const c = {
        name: p.displayName?.text || '—',
        website: p.websiteUri || '',
        address: p.formattedAddress || '',
        description: (industry || subject || ''),
      };
      c.leadScore = score(c);
      return c;
    });

    return res.status(200).json({ mode: 'live', companies });
  } catch (err) {
    console.error('Search error:', err);
    const companies = MOCK.map((c) => ({ ...c, leadScore: score(c) }));
    return res.status(200).json({ mode: 'mock', companies, note: 'fallback due to exception' });
  }
}
