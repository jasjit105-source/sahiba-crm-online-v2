// =====================================================================
// query.js — proxy to the on-premise SQL Server via ngrok tunnel
// =====================================================================
// This is the same proxy pattern from your existing Sahiba apps.
// Used by:
//  - the Phase 3 sales-sync function (server-side)
//  - admin "Run SQL" tool in the dashboard (future)
//
// Auth: requires APP_TOKEN.
// Body: { query: "SELECT ..." }
// =====================================================================

const { preflight, requireAuth, unauthorized, badRequest, serverError, parseBody, CORS_HEADERS } = require('./_shared');

const NGROK_BASE = process.env.SQL_NGROK_URL || 'https://aggrievedly-spryest-hattie.ngrok-free.dev';
const SQL_TOKEN = process.env.SQL_API_TOKEN || 'Sahiba_CZSfEghwaD4s';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return badRequest('Use POST');

  const auth = requireAuth(event);
  if (!auth.ok) return unauthorized(auth.error);

  try {
    const body = parseBody(event);
    if (!body.query) return badRequest('Missing query');
    const res = await fetch(NGROK_BASE + '/V1/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SQL_TOKEN,
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ query: body.query }),
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    return serverError(err);
  }
};
