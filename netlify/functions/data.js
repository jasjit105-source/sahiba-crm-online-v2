// =====================================================================
// /api/data — read latest dashboard data from Neon
// =====================================================================
// Returns slim CSVs sized to fit under Netlify's 6 MB function response cap.
//
// Slim columns returned:
//   Contacts: ContactID, FirstName, LastName, PhoneNumber, Lifecycle, Assignee, ciudad
//             (drops Email, Country, Language, Tags, Status, DateTimeCreated,
//              LastInteractionTime, Channels, Comentarios, comentario_de_clints,
//              domicilio, videodetienda — none read by dashboard)
//   Messages: Date & Time, Contact ID, Message Type, Content Type, Content
//             (drops Sender ID, Sender Type, Message ID, Channel ID, Type, Sub Type
//              — none read by dashboard)
//
// The dashboard's parser at index.html line ~1245 only references these fields,
// so dropping the rest is purely waste removal — no functional change.
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
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const rows = await sql`
    SELECT contact_id, datetime, message_type, content_type, content_raw
    FROM messages
    WHERE datetime >= ${cutoff}
    ORDER BY datetime DESC
  `;

  // Slim header — only fields the dashboard actually reads
  const header = ['Date & Time', 'Contact ID', 'Message Type', 'Content Type', 'Content'];
  const lines = [csvRow(header)];
  for (const r of rows) {
    lines.push(csvRow([
      fmtDt(r.datetime),
      r.contact_id || '',
      r.message_type || '',
      r.content_type || '',
      r.content_raw || '',
    ]));
  }
  return { csv: lines.join('\n'), count: rows.length };
}

// Slim a contacts CSV row by row, keeping only the columns the dashboard reads.
// Returns { csv, count } where csv is a header + filtered rows.
function slimContactsCsv(fullCsv, activeIds) {
  const lines = fullCsv.split('\n');
  if (lines.length < 2) return { csv: '', count: 0 };

  // Parse header to find columns we care about (case-insensitive match on
  // common variations the index.html parser tolerates).
  const headerCells = lines[0].split(',').map(s => s.replace(/^"|"$/g, '').trim());
  const headerLower = headerCells.map(s => s.toLowerCase());

  function findCol(names) {
    for (const n of names) {
      const i = headerLower.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  }

  // Map: output column name → source column index in input CSV.
  // These names match the keys index.html's pk() helper looks for.
  const colMap = [
    { out: 'ContactID',   src: findCol(['ContactID', 'Contact ID', 'contact_id', 'id']) },
    { out: 'FirstName',   src: findCol(['FirstName', 'first_name']) },
    { out: 'LastName',    src: findCol(['LastName', 'last_name']) },
    { out: 'PhoneNumber', src: findCol(['PhoneNumber', 'phone', 'phone_number', 'mobile']) },
    { out: 'Lifecycle',   src: findCol(['Lifecycle', 'lifecycle']) },
    { out: 'Assignee',    src: findCol(['Assignee', 'assignee', 'Assigned Agent']) },
    { out: 'ciudad',      src: findCol(['ciudad', 'city', 'City']) },
  ];

  const idCol = colMap[0].src; // ContactID source index for active filter

  // Build output header
  const outHeader = colMap.map(c => c.out).join(',');
  const out = [outHeader];

  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    // Cheap CSV split — fine because we don't need quoted-comma support for
    // ContactID/phone/lifecycle (digits + simple text). Comments/free-text
    // columns are dropped entirely so quote handling isn't needed.
    const cells = ln.split(',');
    const cid = idCol >= 0 ? (cells[idCol] || '').replace(/^"|"$/g, '').trim() : '';
    if (!activeIds.has(cid)) continue;

    const outCells = colMap.map(c => {
      if (c.src < 0) return '';
      const v = (cells[c.src] || '').replace(/^"|"$/g, '');
      return csvCell(v);
    });
    out.push(outCells.join(','));
  }

  return { csv: out.join('\n'), count: out.length - 1 };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    await ensureSchema();
    const sql = db();

    // Parse window from query string. Default 2 days (matches index.html default).
    // Cap at 90 — the slim payload typically fits 30+ days under 6 MB now,
    // but 90 is a hard ceiling so a runaway upload can't blow the cap.
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    const windowDays = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '2', 10)));

    // Build slim messages CSV — drops Sender ID/Type, Message ID, Channel ID, Type, Sub Type
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

    // Find active contact_ids — only those with messages in the window.
    // 120k contacts in DB → typically <2k active in a 2-7 day window.
    const activeIdsRows = await sql`
      SELECT DISTINCT contact_id
      FROM messages
      WHERE datetime >= ${new Date(Date.now() - windowDays * 86400000).toISOString()}
        AND contact_id IS NOT NULL AND contact_id <> ''
    `;
    const activeIds = new Set(activeIdsRows.map(r => r.contact_id));

    // Load full contacts CSV and slim it server-side
    let contactsCSV = '';
    let contactCount = 0;
    if (contactsMeta.length) {
      const contactsBlob = await sql`
        SELECT csv_text FROM csv_blobs WHERE kind = 'contacts'
        ORDER BY uploaded_at DESC LIMIT 1
      `;
      const slim = slimContactsCsv(contactsBlob[0].csv_text, activeIds);
      contactsCSV = slim.csv;
      contactCount = slim.count;
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
