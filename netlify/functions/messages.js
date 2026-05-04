// =====================================================================
// /api/messages — paginated, slim message rows for dashboard
// =====================================================================
// Returns messages in chunks of `limit` rows, ordered by datetime DESC,
// using a cursor (last-row datetime + message_id) for stable pagination.
//
// Why pagination: Netlify Functions cap responses at 6 MB. Returning
// every message in a window (e.g. 30 days = 45k rows × ~500 bytes each
// = 22 MB) blows the cap. Pagination keeps every response under cap
// while still letting the dashboard reconstruct the full dataset.
//
// Query params:
//   days   = window size (1..180, default 7)
//   limit  = max rows per page (default 5000, hard cap 8000)
//   cursorDt = ISO datetime of the last row from previous page (optional)
//   cursorId = message_id of the last row from previous page (optional)
//
// Response:
//   {
//     status: 'ok',
//     messages: [ { dt, ci, mt, ct, cn }, ... ],   // SLIM rows
//     nextCursor: { dt, id } | null,                // null = end of dataset
//     pageCount: <int>,
//     hasMore: <bool>,
//     windowDays: <int>
//   }
//
// Slim row format (compact keys to reduce JSON overhead):
//   dt = Date & Time (YYYY-MM-DD HH:MM:SS)
//   ci = Contact ID
//   mt = Message Type ("incoming"/"outgoing")
//   ct = Content Type ("text"/"attachment"/etc)
//   cn = Content (text body, OR slim attachment marker)
//
// Attachment slim rule: the dashboard at index.html line ~1231 detects
// incoming images via `ct.includes('attachment') && r.includes('image/')`.
// We preserve "image/<type>" for image attachments and strip everything
// else from attachment JSON blobs (S3 URLs, file sizes, etc).
// =====================================================================

const { db, preflight, ok, CORS_HEADERS } = require('./_shared');

// Hard caps — never let a client request something that could blow 6 MB.
const MAX_LIMIT = 8000;
const DEFAULT_LIMIT = 5000;
const MAX_DAYS = 180;
const DEFAULT_DAYS = 7;

// Format datetime for CSV/dashboard — match Respond.io's "YYYY-MM-DD HH:MM:SS"
function fmtDt(d) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ` +
         `${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}

// Slim a message's content_raw to keep only what the dashboard reads.
// For text: keep full content (dashboard searches for "pago recibido" etc).
// For image attachments: keep "[image/jpeg]" stub (preserves dashboard's image detector).
// For other attachments: "[attachment]" stub.
function slimContent(contentRaw, contentType) {
  if (!contentRaw) return '';
  const ct = (contentType || '').toLowerCase();
  if (!ct.includes('attachment')) return contentRaw;
  const imgMatch = /image\/[a-z0-9]+/i.exec(contentRaw);
  if (imgMatch) return '[' + imgMatch[0] + ']';
  return '[attachment]';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const sql = db();
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);

    const days = Math.max(1, Math.min(MAX_DAYS,
      parseInt(url.searchParams.get('days') || String(DEFAULT_DAYS), 10)));
    const limit = Math.max(100, Math.min(MAX_LIMIT,
      parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10)));
    const cursorDt = url.searchParams.get('cursorDt') || null;
    const cursorId = url.searchParams.get('cursorId') || null;

    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    // Pagination uses a stable (datetime DESC, message_id DESC) cursor.
    // For "give me the next page after this row":
    //   WHERE datetime < cursorDt OR (datetime = cursorDt AND message_id < cursorId)
    // This handles the rare case of multiple messages with identical timestamps.
    let rows;
    if (cursorDt && cursorId) {
      rows = await sql`
        SELECT message_id, contact_id, datetime, message_type, content_type, content_raw
        FROM messages
        WHERE datetime >= ${cutoff}
          AND (
            datetime < ${cursorDt}
            OR (datetime = ${cursorDt} AND message_id < ${cursorId})
          )
        ORDER BY datetime DESC, message_id DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT message_id, contact_id, datetime, message_type, content_type, content_raw
        FROM messages
        WHERE datetime >= ${cutoff}
        ORDER BY datetime DESC, message_id DESC
        LIMIT ${limit}
      `;
    }

    // Build slim payload using compact keys to minimize JSON overhead.
    const messages = rows.map(r => ({
      dt: fmtDt(r.datetime),
      ci: r.contact_id || '',
      mt: r.message_type || '',
      ct: r.content_type || '',
      cn: slimContent(r.content_raw, r.content_type),
    }));

    // If we got a full page, there might be more — emit a cursor pointing
    // at the last row. If we got fewer rows than limit, we're done.
    let nextCursor = null;
    let hasMore = false;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      nextCursor = {
        dt: last.datetime instanceof Date ? last.datetime.toISOString() : last.datetime,
        id: last.message_id,
      };
      hasMore = true;
    }

    return ok({
      status: 'ok',
      messages,
      nextCursor,
      pageCount: messages.length,
      hasMore,
      windowDays: days,
    });
  } catch (err) {
    console.error('Messages error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ status: 'error', error: err.message }),
    };
  }
};
