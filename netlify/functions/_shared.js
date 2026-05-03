// =====================================================================
// Shared helpers for all Netlify Functions — Sahiba CRM v2
// =====================================================================

const { neon } = require('@neondatabase/serverless');

let _sql = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    _sql = neon(url);
  }
  return _sql;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function preflight() {
  return { statusCode: 200, headers: CORS_HEADERS, body: '' };
}

function requireAuth(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  const expected = process.env.APP_TOKEN;
  if (!expected) return { ok: false, status: 500, error: 'APP_TOKEN not configured on server' };
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token !== expected) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

const ok = (b) => json(200, b);
const badRequest = (m) => json(400, { error: m });
const unauthorized = (m) => json(401, { error: m || 'Unauthorized' });
const notFound = (m) => json(404, { error: m || 'Not found' });
const serverError = (err) => {
  console.error('Function error:', err);
  return json(500, { error: err.message || String(err), type: err.constructor && err.constructor.name });
};

function getPath(event, functionName) {
  const raw = event.path || '';
  return raw
    .replace(`/.netlify/functions/${functionName}`, '')
    .replace(`/api/${functionName}`, '')
    .replace('/.netlify/functions/api', '')
    .replace('/api', '') || '/';
}

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}

// Phone normalization for cross-system matching (Respond.io ↔ SQL Server)
// Returns 10-digit Mexican phone (strips country code, removes all non-digits)
// or null if the input doesn't yield a valid 10-digit phone.
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Strip country code variations:
  //   +52 1 5512345678 → 5215512345678 (13 digits) → take last 10
  //   +52 5512345678 → 525512345678 (12 digits) → take last 10
  //   1 5512345678 (US-style) → 15512345678 (11 digits) → take last 10
  //   5512345678 (already 10) → keep
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length !== 10) return null;
  return digits;
}

// Style code → category mapping (last 2 letters of style code)
// Sahiba product code rule: 517VE = Vestido (Dress)
// Add new codes here as they're confirmed.
const STYLE_CODE_MAP = {
  'VE': 'Vestido',     // Dress
  'TU': 'Blusa',       // Blouse
  'BA': 'Bata',        // Bata dress
};
function categoryFromCode(code) {
  if (!code) return null;
  const s = String(code).toUpperCase().trim();
  // Try last 2 letters
  if (s.length >= 2) {
    const suffix = s.slice(-2);
    if (STYLE_CODE_MAP[suffix]) return STYLE_CODE_MAP[suffix];
  }
  return null;
}

// Beach / tourist cities — priority 1 = highest
// Customers in these cities are more likely to buy wholesale for boutiques
const BEACH_CITIES = {
  // Priority 1: top tourist destinations
  'CANCUN':           { state: 'Quintana Roo', priority: 1 },
  'TULUM':            { state: 'Quintana Roo', priority: 1 },
  'PLAYA DEL CARMEN': { state: 'Quintana Roo', priority: 1 },
  'COZUMEL':          { state: 'Quintana Roo', priority: 1 },
  // Priority 2: major beach
  'PUERTO VALLARTA':  { state: 'Jalisco',      priority: 2 },
  'LOS CABOS':        { state: 'Baja California Sur', priority: 2 },
  'CABO SAN LUCAS':   { state: 'Baja California Sur', priority: 2 },
  'MAZATLAN':         { state: 'Sinaloa',      priority: 2 },
  'MERIDA':           { state: 'Yucatan',      priority: 2 },
  // Priority 3: secondary
  'VERACRUZ':         { state: 'Veracruz',     priority: 3 },
  'OAXACA':           { state: 'Oaxaca',       priority: 3 },
  'ACAPULCO':         { state: 'Guerrero',     priority: 3 },
  'HUATULCO':         { state: 'Oaxaca',       priority: 3 },
  'PUERTO ESCONDIDO': { state: 'Oaxaca',       priority: 3 },
  'IXTAPA':           { state: 'Guerrero',     priority: 3 },
  'ZIHUATANEJO':      { state: 'Guerrero',     priority: 3 },
};
function normalizeCityName(raw) {
  if (!raw) return null;
  // Uppercase, strip accents, trim
  return String(raw)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().trim();
}
function beachCityInfo(rawCity) {
  const norm = normalizeCityName(rawCity);
  if (!norm) return null;
  // Direct match
  if (BEACH_CITIES[norm]) return BEACH_CITIES[norm];
  // Partial match (e.g. "Cancun, QR" or "Playa Del Carmen Centro")
  for (const k of Object.keys(BEACH_CITIES)) {
    if (norm.includes(k)) return BEACH_CITIES[k];
  }
  return null;
}

// Map Respond.io assignee email → agent name
// Note: Ruth removed (no longer active). Nancy = E-COMMERCE in MOVS_LEONA.
const AGENT_MAP = {
  'asesorce3@sahiba.com':  'Jazmin',
  'sahibaleona@gmail.com': 'Nancy',
  'ymsahiba78@gmail.com':  'Yoana',
};
function mapAgent(email) {
  if (!email) return 'Unassigned';
  const e = String(email).trim().toLowerCase();
  return AGENT_MAP[e] || 'Unassigned';
}

// Map SQL Server vendedor → agent name (for cross-system unification)
const VENDEDOR_TO_AGENT = {
  'YAZMIN':     'Jazmin',
  'YOANA':      'Yoana',
  'E-COMMERCE': 'Nancy',
};
function vendedorToAgent(v) {
  if (!v) return null;
  return VENDEDOR_TO_AGENT[String(v).trim().toUpperCase()] || null;
}

// Store code → friendly name and vendedor table mapping
const STORE_INFO = {
  'TS0001': { name: 'Leona Vicario',   table: 'MOVS_LEONA' },
  'TS0002': { name: 'Cercu',           table: 'MOVS_CIRCUNVALACION' },
  'TS0003': { name: 'Lecumberri',      table: 'MOVS_LECUMBERRI' },
  'TS0004': { name: 'Chinconcuac',     table: 'MOVS_CHINCONCUAC' },
};

module.exports = {
  db, CORS_HEADERS, preflight, requireAuth, json, ok, badRequest,
  unauthorized, notFound, serverError, getPath, parseBody,
  normalizePhone, mapAgent, AGENT_MAP,
  categoryFromCode, STYLE_CODE_MAP,
  beachCityInfo, normalizeCityName, BEACH_CITIES,
  vendedorToAgent, VENDEDOR_TO_AGENT,
  STORE_INFO,
};
