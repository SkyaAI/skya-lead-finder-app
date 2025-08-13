// /api/search.js — Search + keyless enrichment (emails from site + LinkedIn role searches)

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const body = await readJSON(req);
  const subject  = (body.subject  || '').trim();
  const industry = (body.industry || '').trim();
  const location = (body.location || '').trim();

  const queryUsed = [subject, industry, location ? `in ${location}` : ""]
    .filter(Boolean).join(" ").trim() || "manufacturer";

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // helpers for scoring
  const tokens = s => String(s || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const containsAll = (text, q) => {
    if (!q || !q.trim()) return true;
    const t = String(text || '').toLowerCase();
    return tokens(q).every(tok => t.includes(tok));
  };
  const score = c => {
    const combined = [c.name, c.description, c.address, c.website].join(' ');
    let s = 0;
    if (containsAll(combined, subject))  s += 50;
    if (containsAll(combined, industry)) s += 30;
    if (containsAll(c.address || '', location)) s += 20;
    return Math.max(10, Math.min(100, s || 10));
  };

  try {
    // --- Get companies (Google v1 -> legacy -> OSM) ---
    let companies = [];
    let mode = 'live-osm';
    if (apiKey) {
      try {
        companies = await fetchGoogleV1(queryUsed, apiKey, 15);
        mode = 'live-v1';
      } catch (e1) {
        try {
          companies = await fetchLegacy(queryUsed, apiKey, 15);
          mode = 'live-legacy';
        } catch (e2) {
          // will fall back to OSM below
        }
      }
    }
    if (companies.length === 0) {
      companies = await fetchOSM(queryUsed, location, 20);
      mode = 'live-osm';
    }

    // --- Enrich: public emails + LinkedIn search links ---
    const roles = [
      'CEO','COO','CTO','Head of Operations','Head of Supply Chain',
      'Operations Manager','Supply Chain Manager'
    ];

    const enriched = [];
    for (const base of companies.slice(0, 15)) {
      const emails = await fetchPublicEmails(base.website);
      const linkedinSearch = buildLinkedInSearch(base.name, roles);
      const item = {
        ...base,
        description: `${subject} ${industry}`.trim(),
        emails,
        linkedinSearch,
        leadScore: score(base)
      };
      enriched.push(item);
    }

    return res.status(200).json({ mode, queryUsed, companies: enriched });
  } catch (err) {
    const MOCK = [
      { name:'AI Logistics Pty Ltd', website:'https://ailogistics.example', address:'CBD, Sydney' },
      { name:'Smart Manufacturing AI', website:'https://smaiai.example', address:'North Sydney' }
    ].map(c => ({ ...c, leadScore: score(c), emails: [], linkedinSearch: buildLinkedInSearch(c.name, ['CEO']) }));
    return res.status(200).json({
      mode: 'mock-error',
      queryUsed,
      companies: MOCK,
      errorMessage: String(err?.message || err)
    });
  }
}

// ---------- helpers ----------
async function readJSON(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// Google Places API v1
async function fetchGoogleV1(query, apiKey, limit = 15) {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const body = { textQuery: query, maxResultCount: Math.min(limit, 20), languageCode: 'en' };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.websiteUri,places.formattedAddress'
    },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Google v1 ${r.status}: ${txt}`);
  const data = JSON.parse(txt);
  return (data.places || []).map(p => ({
    name: p.displayName?.text || '—',
    website: p.websiteUri || '',
    address: p.formattedAddress || ''
  }));
}

// Legacy Text Search
async function fetchLegacy(query, apiKey, limit = 15) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`legacy ${data.status}: ${data.error_message || ''}`);
  }
  return (data.results || []).slice(0, limit).map(p => ({
    name: p.name || '—',
    website: '',
    address: p.formatted_address || ''
  }));
}

// OpenStreetMap / Overpass fallback (no key)
async function fetchOSM(query, location, limit = 20) {
  const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
  const regex = words.length ? words.map(w => escapeRegex(w)).join('|') : 'manufact|factory|industrial';
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
      'User-Agent': 'SkyaLeadFinder/1.0 (contact: info@auzkiwi.com)'
    },
    body: new URLSearchParams({ data: ql })
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OSM ${r.status}: ${txt}`);
  const data = JSON.parse(txt);

  return (data.elements || []).map(el => {
    const t = el.tags || {};
    const addr = [
      t['addr:housenumber'], t['addr:street'],
      t['addr:suburb'] || t['addr:city'],
      t['addr:state'], t['addr:postcode'], t['addr:country']
    ].filter(Boolean).join(', ');
    return {
      name: t.name || '—',
      website: t.website || t['contact:website'] || '',
      address: addr || t['addr:full'] || ''
    };
  }).filter(x => x.name && x.name !== '—');
}

// Try to extract public emails from homepage and common contact pages
async function fetchPublicEmails(website) {
  const out = new Set();
  if (!website) return [];
  const base = normalizeUrl(website);
  const candidates = [base, base + '/contact', base + '/contact-us', base + '/about', base + '/contacts'];
  for (const url of candidates) {
    try {
      const html = await getWithTimeout(url, 6000);
      for (const email of extractEmails(html)) {
        // skip obvious non-company placeholders
        if (!email.endsWith('.example')) out.add(email.toLowerCase());
        if (out.size >= 3) break;
      }
      if (out.size >= 3) break;
    } catch { /* ignore individual fetch failures */ }
  }
  return Array.from(out);
}

function extractEmails(html) {
  const emails = new Set();
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
  let m; while ((m = re.exec(html)) !== null) emails.add(m[0]);
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
  const company = `"${companyName}"`;
  return roles.map(role => ({
    role,
    url: base + encodeURIComponent(`site:linkedin.com/in "${role}" ${company}`)
  }));
}

function escapeRegex(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeQuotes(s){ return String(s).replace(/"/g, '\\"'); }
