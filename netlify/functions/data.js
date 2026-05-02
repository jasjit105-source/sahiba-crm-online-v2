// =====================================================================
// /api/data — read latest dashboard data from Neon
// =====================================================================
// Returns:
//   {
//     status: 'ok',
//     contactsCSV: "<full csv text>",
//     messagesCSV: "<reconstructed csv text from messages table>",
//     contactCount, messageCount, lastUpload, newContactCount,
//     messagesWindowDays    (how far back the messages CSV reaches)
//   }
//
// The messages CSV is rebuilt on each request from the append-only `messages`
// table, filtered to a configurable window (default 90 days). The dashboard
// frontend already knows how to parse this CSV — no frontend change needed.
// =====================================================================

const { db, preflight, ok, CORS_HEADERS } = require('./_shared');

async function ensureSchema() {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS csv_blobs (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL, csv_text TEXT NOT NULL,
    row_count INTEGER, uploaded_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, contact_id TEXT, datetime TIMESTAMPTZ,
    message_type TEXT, content_type TEXT, content_raw TEXT,
    sender_type TEXT, channel_id TEXT, type_field TEXT, sub_type TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS known_contacts (
    contact_id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ DEFAULT NOW()
  )`;
}

// CSV escape — wrap in quotes if the field has commas, quotes, or newlines
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function csvRow(arr) {
  return arr.map(csvCell).join(',');
}

// Format datetime for CSV — match Respond.io's "YYYY-MM-DD HH:MM:SS" format
function fmtDt(d) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ` +
         `${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}

async function buildMessagesCsv(windowDays) {
  const sql = db();
  // Pull rows within window — chunked to keep memory reasonable
  // 6 months × ~1500 msg/day = ~270k rows max, but typical dashboard window is 30 days
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const rows = await sql`
    SELECT message_id, contact_id, datetime, message_type, content_type,
           content_raw, sender_type, channel_id, type_field, sub_type
    FROM messages
    WHERE datetime >= ${cutoff}
    ORDER BY datetime DESC
  `;

  // Header matches the Respond.io export format the dashboard already parses
  const header = ['Date & Time', 'Sender ID', 'Sender Type', 'Contact ID', 'Message ID',
                  'Content Type', 'Message Type', 'Content', 'Channel ID', 'Type', 'Sub Type'];
  const lines = [csvRow(header)];
  for (const r of rows) {
    lines.push(csvRow([
      fmtDt(r.datetime),
      '',                       // Sender ID — we don't store it separately, leave blank
      r.sender_type || '',
      r.contact_id || '',
      r.message_id || '',
      r.content_type || '',
      r.message_type || '',
      r.content_raw || '',
      r.channel_id || '',
      r.type_field || '',
      r.sub_type || '',
    ]));
  }
  return { csv: lines.join('\n'), count: rows.length };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    await ensureSchema();
    const sql = db();

    // Parse window from query string (?days=30 default)
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    const windowDays = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '90', 10)));

    const contacts = await sql`
      SELECT csv_text, row_count, uploaded_at
      FROM csv_blobs WHERE kind = 'contacts'
      ORDER BY uploaded_at DESC LIMIT 1
    `;

    const { csv: messagesCSV, count: messageCount } = await buildMessagesCsv(windowDays);

    if (!contacts.length && messageCount === 0) {
      return ok({
        status: 'ok', contactsCSV: '', messagesCSV: '',
        contactCount: 0, messageCount: 0,
        messagesWindowDays: windowDays,
      });
    }

    const lastUpload = contacts[0] ? contacts[0].uploaded_at : null;

    let newContactCount = 0;
    try {
      const r = await sql`SELECT COUNT(*)::int AS c FROM known_contacts WHERE first_seen >= NOW() - INTERVAL '24 hours'`;
      newContactCount = r[0].c;
    } catch (e) { /* ok */ }

    return ok({
      status: 'ok',
      contactsCSV: contacts[0] ? contacts[0].csv_text : '',
      messagesCSV,
      contactCount: contacts[0] ? contacts[0].row_count : 0,
      messageCount,
      lastUpload,
      newContactCount,
      messagesWindowDays: windowDays,
    });
  } catch (err) {
    console.error('Data error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ status: 'error', error: err.message }) };
  }
};
