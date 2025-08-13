// /api/search.js
//
// This endpoint performs a simple company search using either the
// Google Places API (if a key is supplied) or OpenStreetMap as a
// fallback.  Results are enriched with any publicly available email
// addresses found on the company’s website and with links to search
// LinkedIn for common executive roles.  A numeric lead score is
// assigned based on how well the company matches the supplied
// subject, industry and location.  The handler supports both GET and
// POST requests: GET parameters are read from the query string and
// POST parameters from a JSON body.  The GET support avoids issues
// with platforms (e.g. Vercel) that only allow GET requests by default.

export default async function handler(req, res) {
  // Always disable caching so users get fresh data on every request.
  res.setHeader('Cache-Control', 'no-store');

  // Extract parameters from either the query string (GET) or
  // the request body (POST).  Normalise all fields to strings.
  let subject = '';
  let industry = '';
  let location = '';
  let fullFlag = false;

  if (req.method === 'GET') {
    // req.url includes the path and query; use a dummy base to parse
    const urlObj = new URL(req.url, 'http://localhost');
    subject = (urlObj.searchParams.get('subject') || '').trim();
    industry = (urlObj.searchParams.get('industry') || '').trim();
    location = (urlObj.searchParams.get('location') || '').trim();
    const fullParam = urlObj.searchParams.get('full');
    fullFlag = fullParam === 'true' || fullParam === '1';
  } else if (req.method === 'POST') {
    const body = await readJSON(req);
    subject = (body.subject || '').trim();
    industry = (body.industry || '').trim();
    location = (body.location || '').trim();
    fullFlag = body.full === true || body.full === 'true' || body.full === 1;
  } else {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // Build a human readable query string used in the UI.
  const queryUsed = [subject, industry, location ? `in ${location}` : '']
    .filter(Boolean)
    .join(' ')
    .trim() || 'manufacturer';

  // Determine the maximum number of companies to fetch.  When the
  // caller requests the full list we fetch more results; otherwise we
  // fetch a modest number (15) and rely on the client to slice to 10.
  const maxResults = fullFlag ? 40 : 15;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // Simple scoring helpers
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

  try {
    // --- Fetch candidate companies via Google or OSM ---
    let companies = [];
    let mode = 'live-osm';
    if (apiKey) {
      try {
        companies = await fetchGoogleV1(queryUsed, apiKey, maxResults);
        mode = 'live-v1';
      } catch (e1) {
        try {
          companies = await fetchLegacy(queryUsed, apiKey, maxResults);
          mode = 'live-legacy';
        } catch (e2) {
          // fall through to OSM below
        }
      }
    }
    if (companies.length === 0) {
      companies = await fetchOSM(queryUsed, location, maxResults);
      mode = 'live-osm';
    }
    const totalMatches = companies.length;
    // --- Enrich results with emails and LinkedIn search links ---
    const roles = [
      'CEO',
      'COO',
      'CTO',
      'Head of Operations',
      'Head of Supply Chain',
      'Operations Manager',
      'Supply Chain Manager',
    ];
    const enriched = [];
    // Only process up to maxResults companies to avoid long delays
    for (const base of companies.slice(0, maxResults)) {
      const emails = await fetchPublicEmails(base.website);
      const linkedinSearch = buildLinkedInSearch(base.name, roles);
      const item = {
        ...base,
        description: `${subject} ${industry}`.trim(),
        emails,
        linkedinSearch,
        leadScore: score(base),
      };
      enriched.push(item);
    }
    return res.status(200).json({
      mode,
      queryUsed,
      total: totalMatches,
      companies: enriched,
    });
  } catch (err) {
    // When something goes wrong (e.g. API quota exhausted) return a
    // small mock dataset.  Including lead scores here ensures the UI
    // still sorts correctly.  Also return the error message for display.
    const MOCK = [
      { name: 'AI Logistics Pty Ltd', website: 'https://ailogistics.example', address: 'CBD, Sydney' },
      { name: 'Smart Manufacturing AI', website: 'https://smaiai.example', address: 'North Sydney' },
    ].map((c) => ({
      ...c,
      leadScore: score(c),
      emails: [],
      linkedinSearch: buildLinkedInSearch(c.name, ['CEO']),
    }));
    return res.status(200).json({
      mode: 'mock-error',
      queryUsed,
      total: MOCK.length,
      companies: MOCK,
      errorMessage: String(err?.message || err),
    });
  }
}

// ---------- Helper functions ----------
async function readJSON(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Google Places API v1 (Places SDK for Web service)
async function fetchGoogleV1(query, apiKey, limit = 15) {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const body = { textQuery: query, maxResultCount: Math.min(limit, 20), languageCode: 'en' };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.websiteUri,places.formattedAddress',
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Google v1 ${r.status}: ${txt}`);
  const data = JSON.parse(txt);
  return (data.places || []).map((p) => ({
    name: p.displayName?.text || '—',
    website: p.websiteUri || '',
    address: p.formattedAddress || '',
  }));
}

// Google Places legacy Text Search API
async function fetchLegacy(query, apiKey, limit = 15) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`legacy ${data.status}: ${data.error_message || ''}`);
  }
  return (data.results || [])
    .slice(0, limit)
    .map((p) => ({ name: p.name || '—', website: '', address: p.formatted_address || '' }));
}

// OpenStreetMap / Overpass fallback (no key required)
async function fetchOSM(query, location, limit = 20) {
  const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
  const regex = words.length ? words.map((w) => escapeRegex(w)).join('|') : 'manufact|factory|industrial';
  const areaClause = location
    ? `area["name"="${escapeQuotes(location)}"]["boundary"="administrative"]->.a;`
    : `area["name"="Australia"]["boundary"="administrative"]->.a;`;
  const ql = `
    [out:json][timeout:25];
    ${areaClause}
    (
      nwr(area.a)["name"~"${regex}", i];
      nwr(area.a)["office"="company"];
      nwr(area.a)["man_made"="works"];
      nwr(area.a)["industrial"];
    );
    out tags center ${limit};
  `;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'SkyaLeadFinder/1.0 (contact: info@auzkiwi.com)',
    },
    body: new URLSearchParams({ data: ql }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OSM ${r.status}: ${txt}`);
  const data = JSON.parse(txt);
  return (data.elements || [])
    .map((el) => {
      const t = el.tags || {};
      const addr = [
        t['addr:housenumber'],
        t['addr:street'],
        t['addr:suburb'] || t['addr:city'],
        t['addr:state'],
        t['addr:postcode'],
        t['addr:country'],
      ]
        .filter(Boolean)
        .join(', ');
      return {
        name: t.name || '—',
        website: t.website || t['contact:website'] || '',
        address: addr || t['addr:full'] || '',
      };
    })
    .filter((x) => x.name && x.name !== '—');
}

// Extract publicly visible emails from a company website and common contact pages.
async function fetchPublicEmails(website) {
  const out = new Set();
  if (!website) return [];
  const base = normalizeUrl(website);
  const candidates = [
    base,
    base + '/contact',
    base + '/contact-us',
    base + '/about',
    base + '/contacts',
  ];
  for (const url of candidates) {
    try {
      const html = await getWithTimeout(url, 6000);
      for (const email of extractEmails(html)) {
        // Skip obvious placeholder domains
        if (!email.endsWith('.example')) out.add(email.toLowerCase());
        if (out.size >= 3) break;
      }
      if (out.size >= 3) break;
    } catch {
      /* ignore individual fetch failures */
    }
  }
  return Array.from(out);
}

function extractEmails(html) {
  const emails = new Set();
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
  let m;
  while ((m = re.exec(html)) !== null) emails.add(m[0]);
  return Array.from(emails);
}

function normalizeUrl(u) {
  try {
    const url = new URL(u.startsWith('http') ? u : 'https://' + u);
    url.hash = '';
    return url.origin;
  } catch {
    return '';
  }
}

async function getWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'SkyaLeadFinder/1.0' } });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function buildLinkedInSearch(companyName, roles) {
  const base = 'https://www.google.com/search?q=';
  const company = '"' + companyName + '"';
  return roles.map((role) => ({
    role,
    url: base + encodeURIComponent(`site:linkedin.com/in "${role}" ${company}`),
  }));
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeQuotes(s) {
  return String(s).replace(/"/g, '\\"');
}