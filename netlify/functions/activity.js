// =====================================================================
// /api/activity — Agent usage tracker
// =====================================================================
// Receives beacon pings from agent CRM views.
// Stores: page_open, tab_click, whatsapp_click, call_click, search_use,
//         heartbeat, session_end
//
// GET  /api/activity?days=7        → returns activity summary for admin
// POST /api/activity               → logs an event (from sendBeacon)
// =====================================================================

const { db, CORS_HEADERS, preflight, json, ok, serverError } = require('./_shared');

// Ensure table exists (runs once per cold start)
let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id         SERIAL PRIMARY KEY,
      agent      TEXT NOT NULL,
      event      TEXT NOT NULL,
      detail     JSONB,
      ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Index for fast lookups
  await sql`
    CREATE INDEX IF NOT EXISTS idx_activity_agent_ts ON agent_activity(agent, ts DESC)
  `;
  _tableReady = true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    await ensureTable();
    const sql = db();

    // ── POST: log an event ──
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body); } catch (_) {}

      const agent = String(body.agent || '').trim();
      const evt = String(body.event || '').trim();
      if (!agent || !evt) {
        return json(400, { error: 'agent and event required' });
      }

      await sql`
        INSERT INTO agent_activity (agent, event, detail, ts)
        VALUES (${agent}, ${evt}, ${JSON.stringify(body.detail || null)}, ${body.ts || new Date().toISOString()})
      `;

      return json(200, { ok: true });
    }

    // ── GET: activity summary for admin dashboard ──
    if (event.httpMethod === 'GET') {
      const days = parseInt((event.queryStringParameters || {}).days) || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString();

      // Daily summary per agent
      const daily = await sql`
        SELECT
          agent,
          DATE(ts AT TIME ZONE 'America/Mexico_City') AS day,
          COUNT(*) FILTER (WHERE event = 'page_open')       AS opens,
          COUNT(*) FILTER (WHERE event = 'tab_click')       AS tab_clicks,
          COUNT(*) FILTER (WHERE event = 'whatsapp_click')  AS whatsapp_clicks,
          COUNT(*) FILTER (WHERE event = 'call_click')      AS call_clicks,
          COUNT(*) FILTER (WHERE event = 'search_use')      AS searches,
          COUNT(*) FILTER (WHERE event = 'heartbeat')       AS heartbeats,
          COUNT(*) FILTER (WHERE event = 'session_end')     AS sessions_ended,
          MIN(ts) AS first_activity,
          MAX(ts) AS last_activity
        FROM agent_activity
        WHERE ts >= ${since}
        GROUP BY agent, DATE(ts AT TIME ZONE 'America/Mexico_City')
        ORDER BY day DESC, agent
      `;

      // Session durations from session_end events
      const sessions = await sql`
        SELECT agent, ts, detail
        FROM agent_activity
        WHERE event = 'session_end' AND ts >= ${since}
        ORDER BY ts DESC
        LIMIT 100
      `;

      // Today's activity (quick check: did they open today?)
      const todayMX = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
      const today = await sql`
        SELECT
          agent,
          COUNT(*) FILTER (WHERE event = 'page_open')       AS opens,
          COUNT(*) FILTER (WHERE event = 'whatsapp_click')  AS wa,
          COUNT(*) FILTER (WHERE event = 'call_click')      AS calls,
          COUNT(*) FILTER (WHERE event = 'heartbeat')       AS heartbeats,
          MIN(ts) AS first_open,
          MAX(ts) AS last_seen
        FROM agent_activity
        WHERE DATE(ts AT TIME ZONE 'America/Mexico_City') = ${todayMX}
        GROUP BY agent
      `;

      return ok({
        days,
        today: today || [],
        daily: daily || [],
        recent_sessions: sessions || []
      });
    }

    return json(405, { error: 'Method not allowed' });

  } catch (err) {
    return serverError(err);
  }
};
