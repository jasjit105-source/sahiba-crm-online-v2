// =====================================================================
// /api/upload — admin-only chunked CSV upload
// =====================================================================
// Two upload kinds:
//
// CONTACTS (snapshot replace, single shot):
//   POST { kind:'contacts', csv: "...", uploadId: "abc123" }
//
// MESSAGES (append, chunked):
//   POST { kind:'messages', csv: "<chunk text>", chunkIndex: 0,
//          totalChunks: 12, uploadId: "abc123" }
//   Each chunk parses its rows and INSERTs into `messages` deduped by message_id
//
// LEGACY back-compat:
//   POST { contactsCSV: "...", messagesCSV: "..." }
// =====================================================================

const { db, preflight, requireAuth, ok, badRequest, unauthorized, parseBody, CORS_HEADERS } = require('./_shared');

async function ensureSchema() {
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS csv_blobs (
      id SERIAL PRIMARY KEY, kind TEXT NOT NULL, csv_text TEXT NOT NULL,
      row_count INTEGER, uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_csv_kind_time ON csv_blobs(kind, uploaded_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY, contact_id TEXT, datetime TIMESTAMPTZ,
      message_type TEXT, content_type TEXT, content_raw TEXT,
      sender_type TEXT, channel_id TEXT, type_field TEXT, sub_type TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_msg_contact ON messages(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_msg_datetime ON messages(datetime DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS known_contacts (
      contact_id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      agent TEXT, contact_id TEXT, name TEXT, phone TEXT,
      action TEXT, notes TEXT, score TEXT, priority TEXT,
      city TEXT, lifecycle TEXT,
      logged_at TIMESTAMPTZ DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS sales_history (
      id BIGSERIAL PRIMARY KEY,
      store TEXT, vendedor TEXT, ticket TEXT, fecha DATE,
      articulo TEXT, descripcion TEXT, linea TEXT,
      cantidad NUMERIC, precio_venta NUMERIC, line_amount NUMERIC,
      cust_phone TEXT, cust_phone_normalized TEXT, cust_cliente TEXT,
      cust_guia TEXT, cust_pago TEXT,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(ticket, articulo, vendedor)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_phone_norm ON sales_history(cust_phone_normalized)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_fecha ON sales_history(fecha DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS import_log (
      id SERIAL PRIMARY KEY,
      kind TEXT, source TEXT, upload_id TEXT,
      chunk_index INTEGER, total_chunks INTEGER,
      rows_total INTEGER DEFAULT 0,
      rows_inserted INTEGER DEFAULT 0,
      rows_updated INTEGER DEFAULT 0,
      rows_skipped INTEGER DEFAULT 0,
      status TEXT, details JSONB,
      performed_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_log_time ON import_log(performed_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_log_upload ON import_log(upload_id)`;
}

// CSV parser — handles quoted fields, embedded newlines, doubled quotes
function parseCsv(text) {
  const out = { header: [], rows: [] };
  if (!text) return out;
  let cur = '', row = [], inQ = false, lineNum = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
          if (lineNum === 0) out.header = row;
          else out.rows.push(row);
        }
        row = [];
        lineNum++;
      }
      else cur += c;
    }
  }
  if (cur || row.length > 0) {
    row.push(cur);
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
      if (lineNum === 0) out.header = row;
      else out.rows.push(row);
    }
  }
  return out;
}

function colMap(header) {
  const m = {};
  header.forEach((h, i) => { m[String(h || '').toLowerCase().trim()] = i; });
  return m;
}

async function handleContactsUpload(csv, uploadId, chunkIndex, totalChunks) {
  const sql = db();
  if (!csv) return { status: 'error', error: 'Empty contacts chunk' };

  // SINGLE-SHOT path: small contacts CSV uploaded as one piece
  // (kept for backward compat and small accounts)
  if (chunkIndex == null || totalChunks == null || totalChunks === 1) {
    if (csv.length < 50) return { status: 'error', error: 'Empty contacts CSV' };
    return await finalizeContactsUpload(csv, uploadId);
  }

  // CHUNKED path: accumulate chunks in a staging table, finalize on last chunk
  await sql`
    CREATE TABLE IF NOT EXISTS contacts_staging (
      upload_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      csv_text TEXT NOT NULL,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (upload_id, chunk_index)
    )`;

  // Store this chunk
  await sql`
    INSERT INTO contacts_staging (upload_id, chunk_index, csv_text)
    VALUES (${uploadId}, ${chunkIndex}, ${csv})
    ON CONFLICT (upload_id, chunk_index) DO UPDATE SET csv_text = EXCLUDED.csv_text
  `;

  // Log this chunk in import_log
  await sql`
    INSERT INTO import_log (kind, source, upload_id, chunk_index, total_chunks,
                            rows_total, rows_inserted, rows_skipped, status)
    VALUES ('contacts-chunk', 'csv-chunk', ${uploadId},
            ${chunkIndex}, ${totalChunks}, 0, 0, 0, 'ok')
  `;

  // If this is NOT the last chunk, just acknowledge
  if (chunkIndex < totalChunks - 1) {
    return { status: 'ok', kind: 'contacts-chunk', chunkIndex, totalChunks, isLastChunk: false };
  }

  // LAST CHUNK: assemble all chunks in order
  const allChunks = await sql`
    SELECT chunk_index, csv_text FROM contacts_staging
    WHERE upload_id = ${uploadId} ORDER BY chunk_index ASC
  `;

  if (allChunks.length !== totalChunks) {
    return {
      status: 'error',
      error: `Missing chunks: got ${allChunks.length} of ${totalChunks}. Try uploading again.`,
    };
  }

  // Reassemble: first chunk has the header, subsequent chunks have header too (from frontend split logic).
  // We need to drop headers from all chunks except the first.
  let assembled = allChunks[0].csv_text;
  for (let i = 1; i < allChunks.length; i++) {
    const chunk = allChunks[i].csv_text;
    const firstNL = chunk.indexOf('\n');
    if (firstNL >= 0) {
      // Drop the duplicated header, keep body
      const body = chunk.slice(firstNL + 1);
      // Make sure we have a newline boundary
      if (!assembled.endsWith('\n')) assembled += '\n';
      assembled += body;
    }
  }

  // Now finalize using the assembled CSV
  const result = await finalizeContactsUpload(assembled, uploadId);

  // Cleanup staging
  await sql`DELETE FROM contacts_staging WHERE upload_id = ${uploadId}`;

  return { ...result, isLastChunk: true, chunksAssembled: totalChunks };
}

async function finalizeContactsUpload(csv, uploadId) {
  const sql = db();
  const parsed = parseCsv(csv);
  const cm = colMap(parsed.header);
  const idIdx = cm['contactid'] != null ? cm['contactid']
              : cm['contact_id'] != null ? cm['contact_id']
              : cm['contact id'];
  const rowCount = parsed.rows.length;
  let newContacts = 0;

  if (idIdx != null) {
    const ids = parsed.rows.map(r => (r[idIdx] || '').trim()).filter(Boolean);
    if (ids.length) {
      const existing = await sql`SELECT contact_id FROM known_contacts WHERE contact_id = ANY(${ids})`;
      const existingSet = new Set(existing.map(r => r.contact_id));
      const newIds = ids.filter(id => !existingSet.has(id));
      newContacts = newIds.length;
      for (let i = 0; i < newIds.length; i += 1000) {
        const chunk = newIds.slice(i, i + 1000);
        await sql`INSERT INTO known_contacts (contact_id) SELECT unnest(${chunk}::text[]) ON CONFLICT DO NOTHING`;
      }
    }
  }

  await sql`DELETE FROM csv_blobs WHERE kind = 'contacts'`;
  await sql`INSERT INTO csv_blobs (kind, csv_text, row_count) VALUES ('contacts', ${csv}, ${rowCount})`;

  await sql`
    INSERT INTO import_log (kind, source, upload_id, rows_total, rows_inserted, rows_skipped, status, details)
    VALUES ('contacts', 'csv', ${uploadId || null}, ${rowCount}, ${rowCount}, ${rowCount - newContacts}, 'ok',
            ${JSON.stringify({ newContacts })})
  `;

  return { status: 'ok', kind: 'contacts', rows: rowCount, newContacts };
}

async function handleMessagesChunk(csv, chunkIndex, totalChunks, uploadId) {
  const sql = db();
  if (!csv) return { status: 'error', error: 'Empty messages chunk' };

  const parsed = parseCsv(csv);
  const cm = colMap(parsed.header);
  const dtIdx = cm['date & time'] != null ? cm['date & time'] : cm['datetime'];
  const cidIdx = cm['contact id'] != null ? cm['contact id'] : cm['contact_id'];
  const midIdx = cm['message id'] != null ? cm['message id'] : cm['message_id'];
  const mtIdx = cm['message type'];
  const ctIdx = cm['content type'];
  const cnIdx = cm['content'];
  const stIdx = cm['sender type'];
  const chIdx = cm['channel id'];
  const tyIdx = cm['type'];
  const sbIdx = cm['sub type'];

  if (midIdx == null || dtIdx == null || cidIdx == null) {
    return { status: 'error', error: 'Missing required columns in messages CSV (need Message ID, Date & Time, Contact ID)' };
  }

  const rowsTotal = parsed.rows.length;
  let rowsInserted = 0, rowsSkipped = 0;
  let firstError = null;

  // Build all tuples first, then batch-insert 50 at a time
  const tuples = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const r = parsed.rows[i];
    let dt = null;
    const rawDt = (r[dtIdx] || '').trim();
    if (rawDt) {
      const d = new Date(rawDt.replace(' ', 'T'));
      if (!isNaN(d)) dt = d.toISOString();
    }
    const message_id = (r[midIdx] || '').trim();
    if (!message_id) { rowsSkipped++; continue; }
    tuples.push({
      message_id,
      contact_id: (r[cidIdx] || '').trim(),
      datetime: dt,
      message_type: ((r[mtIdx] || '') + '').toLowerCase(),
      content_type: ((r[ctIdx] || '') + '').toLowerCase(),
      content_raw: r[cnIdx] || '',
      sender_type: ((r[stIdx] || '') + '').toLowerCase(),
      channel_id: r[chIdx] || '',
      type_field: r[tyIdx] || '',
      sub_type: r[sbIdx] || '',
    });
  }

  // Batch INSERT — use unnest() trick to insert N rows in one round-trip via tagged template
  // (Neon driver only supports tagged-template syntax, not sql.query())
  const BATCH = 100;
  for (let i = 0; i < tuples.length; i += BATCH) {
    const slice = tuples.slice(i, i + BATCH);
    if (slice.length === 0) continue;

    // Build column arrays for unnest()
    const message_ids = slice.map(t => t.message_id);
    const contact_ids = slice.map(t => t.contact_id);
    const datetimes = slice.map(t => t.datetime);
    const message_types = slice.map(t => t.message_type);
    const content_types = slice.map(t => t.content_type);
    const content_raws = slice.map(t => t.content_raw);
    const sender_types = slice.map(t => t.sender_type);
    const channel_ids = slice.map(t => t.channel_id);
    const type_fields = slice.map(t => t.type_field);
    const sub_types = slice.map(t => t.sub_type);

    try {
      const result = await sql`
        INSERT INTO messages (
          message_id, contact_id, datetime, message_type, content_type,
          content_raw, sender_type, channel_id, type_field, sub_type
        )
        SELECT * FROM UNNEST(
          ${message_ids}::text[],
          ${contact_ids}::text[],
          ${datetimes}::timestamptz[],
          ${message_types}::text[],
          ${content_types}::text[],
          ${content_raws}::text[],
          ${sender_types}::text[],
          ${channel_ids}::text[],
          ${type_fields}::text[],
          ${sub_types}::text[]
        )
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      `;
      const inserted = Array.isArray(result) ? result.length : 0;
      rowsInserted += inserted;
      rowsSkipped += (slice.length - inserted);
    } catch (e) {
      rowsSkipped += slice.length;
      if (!firstError) firstError = e.message;
      console.error('Batch insert failed:', e.message);
    }
  }

  await sql`
    INSERT INTO import_log (kind, source, upload_id, chunk_index, total_chunks,
                            rows_total, rows_inserted, rows_skipped, status, details)
    VALUES ('messages', 'csv-chunk', ${uploadId || null},
            ${chunkIndex}, ${totalChunks},
            ${rowsTotal}, ${rowsInserted}, ${rowsSkipped},
            ${firstError ? 'error' : 'ok'},
            ${firstError ? JSON.stringify({ firstError }) : null})
  `;

  // On last chunk, prune anything older than 6 months
  let pruned = 0;
  if (chunkIndex === totalChunks - 1) {
    try {
      const r = await sql`DELETE FROM messages WHERE datetime < NOW() - INTERVAL '6 months' RETURNING message_id`;
      pruned = r.length || 0;
    } catch (e) { /* noop */ }
  }

  return {
    status: 'ok', kind: 'messages',
    chunkIndex, totalChunks,
    rowsTotal, rowsInserted, rowsSkipped, pruned,
    firstError,
    isLastChunk: chunkIndex === totalChunks - 1,
  };
}

async function handleLegacyUpload(body) {
  const stats = { contacts: 0, messages: 0, newContacts: 0 };
  if (body.contactsCSV) {
    const r = await handleContactsUpload(body.contactsCSV, body.uploadId);
    if (r.status !== 'ok') return r;
    stats.contacts = r.rows;
    stats.newContacts = r.newContacts;
  }
  if (body.messagesCSV) {
    const r = await handleMessagesChunk(body.messagesCSV, 0, 1, body.uploadId);
    if (r.status !== 'ok') return r;
    stats.messages = r.rowsInserted;
  }
  return { status: 'ok', ...stats };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return badRequest('Use POST');

  const auth = requireAuth(event);
  if (!auth.ok) return unauthorized(auth.error);

  try {
    await ensureSchema();
    const body = parseBody(event);

    if (body.kind === 'contacts' && typeof body.csv === 'string') {
      return ok(await handleContactsUpload(
        body.csv,
        body.uploadId,
        body.chunkIndex != null ? parseInt(body.chunkIndex, 10) : null,
        body.totalChunks != null ? parseInt(body.totalChunks, 10) : null
      ));
    }
    if (body.kind === 'messages' && typeof body.csv === 'string') {
      return ok(await handleMessagesChunk(
        body.csv,
        parseInt(body.chunkIndex || 0, 10),
        parseInt(body.totalChunks || 1, 10),
        body.uploadId
      ));
    }
    if (body.contactsCSV || body.messagesCSV) {
      return ok(await handleLegacyUpload(body));
    }
    return badRequest('No data — expected {kind, csv, ...}');
  } catch (err) {
    console.error('Upload error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ status: 'error', error: err.message }) };
  }
};
