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

    // Parse window from query string (?days=7 default, max 90 to keep payload <6MB)
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    const windowDays = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '7', 10)));

    // Build messages CSV first — filtered to window (~10k rows for 7 days)
    const { csv: messagesCSV, count: messageCount } = await buildMessagesCsv(windowDays);

    // Get the latest contacts blob metadata (don't load CSV text yet)
    const contactsMeta = await sql`
      SELECT row_count, uploaded_at
      FROM csv_blobs WHERE kind = 'contacts'
      ORDER BY uploaded_at DESC LIMIT 1
    `;

    if (!contactsMeta.length && messageCount === 0) {
      return ok({
        status: 'ok', contactsCSV: '', messagesCSV: '',
        contactCount: 0, messageCount: 0,
        messagesWindowDays: windowDays,
      });
    }

    // Find the active contact_ids — only those with messages in the window
    // This is the key optimization: 120k contacts → ~5k active contacts
    const activeIdsRows = await sql`
      SELECT DISTINCT contact_id
      FROM messages
      WHERE datetime >= ${new Date(Date.now() - windowDays * 86400000).toISOString()}
        AND contact_id IS NOT NULL AND contact_id <> ''
    `;
    const activeIds = new Set(activeIdsRows.map(r => r.contact_id));

    // Now load full contacts CSV and filter rows by active_ids
    let contactsCSV = '';
    let contactCount = 0;
    if (contactsMeta.length) {
      const contactsBlob = await sql`
        SELECT csv_text FROM csv_blobs WHERE kind = 'contacts'
        ORDER BY uploaded_at DESC LIMIT 1
      `;
      const fullCsv = contactsBlob[0].csv_text;
      // Quick split-based filter — find Contact ID column index, keep only rows where it's in activeIds
      const lines = fullCsv.split('\n');
      if (lines.length > 1) {
        const header = lines[0];
        // Detect Contact ID column (case-insensitive)
        const headerCols = header.split(',').map(s => s.replace(/^"|"$/g, '').trim().toLowerCase());
        let idCol = headerCols.indexOf('contact id');
        if (idCol < 0) idCol = headerCols.indexOf('id');
        if (idCol < 0) idCol = 0;

        const filtered = [header];
        for (let i = 1; i < lines.length; i++) {
          const ln = lines[i];
          if (!ln) continue;
          // Cheap CSV split — works because contact IDs are pure digits, no quoted commas
          const cols = ln.split(',');
          const cid = (cols[idCol] || '').replace(/^"|"$/g, '').trim();
          if (activeIds.has(cid)) filtered.push(ln);
        }
        contactsCSV = filtered.join('\n');
        contactCount = filtered.length - 1;
      }
    }

    const lastUpload = contactsMeta[0] ? contactsMeta[0].uploaded_at : null;
    const totalContacts = contactsMeta[0] ? contactsMeta[0].row_count : 0;

    let newContactCount = 0;
    try {
      const r = await sql`SELECT COUNT(*)::int AS c FROM known_contacts WHERE first_seen >= NOW() - INTERVAL '24 hours'`;
      newContactCount = r[0].c;
    } catch (e) { /* ok */ }

    return ok({
      status: 'ok',
      contactsCSV,
      messagesCSV,
      contactCount,         // active contacts in window
      totalContacts,        // total in database (for info)
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
