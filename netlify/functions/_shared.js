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

// Phone normalization for cross-system matching (Respond.io → SQL Server)
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  // Mexican phone: prepend 52 if missing
  if (digits.length === 10) return '52' + digits;
  if (digits.length === 12 && digits.startsWith('52')) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return '52' + digits.slice(1);
  return digits; // give up, keep as-is
}

// Map Respond.io assignee email → agent name (from real app's AG map)
const AGENT_MAP = {
  'asesorce3@sahiba.com': 'Jazmin',
  'sahibaleona@gmail.com': 'Nancy',
  'ymsahiba78@gmail.com': 'Yoana',
};
function mapAgent(email) {
  if (!email) return 'Unassigned';
  const e = String(email).trim().toLowerCase();
  return AGENT_MAP[e] || 'Unassigned';
}

module.exports = {
  db, CORS_HEADERS, preflight, requireAuth, json, ok, badRequest,
  unauthorized, notFound, serverError, getPath, parseBody,
  normalizePhone, mapAgent, AGENT_MAP,
};
