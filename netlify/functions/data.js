// =====================================================================
// /api/data — contacts + summary stats (NO messages)
// =====================================================================
// Messages are now fetched separately via /api/messages with cursor
// pagination, so this endpoint stays well under the Netlify 6 MB cap
// regardless of how many days the dashboard wants.
//
// Returns:
//   {
//     status: 'ok',
//     contactsCSV: <slim CSV with only the columns dashboard reads>,
//     contactCount: <active contacts in window>,
//     totalContacts: <total in DB>,
//     messageCount: <total messages in window — for progress bar>,
//     lastUpload: <ISO timestamp>,
//     newContactCount: <last 24h>,
//     messagesWindowDays: <int>
//   }
//
// The contactsCSV keeps only fields the dashboard's parser at
// index.html line ~1245-1248 actually reads:
//   ContactID, FirstName, LastName, PhoneNumber, Lifecycle, Assignee, ciudad
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

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Slim a contacts CSV to only the columns the dashboard reads, and only
// rows whose ContactID is in the active set (those with messages in window).
function slimContactsCsv(fullCsv, activeIds) {
  const lines = fullCsv.split('\n');
  if (lines.length < 2) return { csv: '', count: 0 };

  const headerCells = lines[0].split(',').map(s => s.replace(/^"|"$/g, '').trim());
  const headerLower = headerCells.map(s => s.toLowerCase());

  function findCol(names) {
    for (const n of names) {
      const i = headerLower.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  }

  // Map output column name → source column index in input CSV.
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

  const idCol = colMap[0].src;
  const out = [colMap.map(c => c.out).join(',')];

  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
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

    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    // Default window 7 days now that messages stream separately and
    // contacts payload is slim. 180 day max guards against runaway.
    const windowDays = Math.max(1, Math.min(180,
      parseInt(url.searchParams.get('days') || '7', 10)));

    const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();

    // Count messages in window — used by frontend for progress bar
    const msgCountRows = await sql`
      SELECT COUNT(*)::int AS c FROM messages WHERE datetime >= ${cutoff}
    `;
    const messageCount = msgCountRows[0]?.c || 0;

    // Find active contact_ids — only those with messages in window
    const activeIdsRows = await sql`
      SELECT DISTINCT contact_id
      FROM messages
      WHERE datetime >= ${cutoff}
        AND contact_id IS NOT NULL AND contact_id <> ''
    `;
    const activeIds = new Set(activeIdsRows.map(r => r.contact_id));

    // Get the latest contacts blob
    const contactsMeta = await sql`
      SELECT row_count, uploaded_at
      FROM csv_blobs WHERE kind = 'contacts'
      ORDER BY uploaded_at DESC LIMIT 1
    `;

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
      const r = await sql`
        SELECT COUNT(*)::int AS c FROM known_contacts
        WHERE first_seen >= NOW() - INTERVAL '24 hours'
      `;
      newContactCount = r[0].c;
    } catch (e) { /* ok */ }

    return ok({
      status: 'ok',
      contactsCSV,
      // messagesCSV intentionally OMITTED — frontend now fetches messages
      // separately via /api/messages?days=N with cursor pagination.
      contactCount,
      totalContacts,
      messageCount,
      lastUpload,
      newContactCount,
      messagesWindowDays: windowDays,
    });
  } catch (err) {
    console.error('Data error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ status: 'error', error: err.message }),
    };
  }
};
