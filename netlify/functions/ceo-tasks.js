// =====================================================================
// /api/ceo-tasks — CEO morning notes ("Tareas mañana / Nota CEO")
// =====================================================================
// Isolated from leads.notes / follow_up_status. Never writes those fields.
//
// GET  /api/ceo-tasks?agent=jazmin&status=open
//      List tasks. No auth (same as /api/data — agents need this after sync).
//
// POST { action: 'upsert', phone, contact_id?, name?, agent?, nota_ceo, batch_date? }
//      Admin write. Requires Bearer APP_TOKEN. Appends nota_ceo with a
//      Mexico City timestamp; does not overwrite existing CEO text.
//
// POST { action: 'hecho', id? | phone?, hecho_por? }
//      Mark done. No auth (same pattern as /api/checkin).
// =====================================================================

const {
  db, preflight, requireAuth, parseBody,
  json, ok, badRequest, unauthorized, serverError,
  normalizePhone,
} = require('./_shared');

const VALID_AGENTS = { jazmin: true, nancy: true, yoana: true };
const MX_TZ = 'America/Mexico_City';

function normalizeAgent(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (VALID_AGENTS[v]) return v;
  if (v.includes('jazmin') || v.includes('jasmin')) return 'jazmin';
  if (v.includes('nancy')) return 'nancy';
  if (v.includes('yoana')) return 'yoana';
  return '';
}

function mexicoStamp(date) {
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('es-MX', {
    timeZone: MX_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function mexicoDate(date) {
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: MX_TZ });
}

function formatMexico(iso) {
  if (!iso) return '';
  return mexicoStamp(iso);
}

function appendNotaCeo(existing, incoming) {
  const text = String(incoming || '').trim();
  if (!text) return existing || '';
  const chunk = '[' + mexicoStamp() + '] ' + text;
  const prev = String(existing || '').trim();
  if (!prev) return chunk;
  return prev + '\n' + chunk;
}

function serializeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    contact_id: row.contact_id || '',
    phone: row.phone || '',
    phone_normalized: row.phone_normalized || '',
    name: row.name || '',
    agent: row.agent || '',
    nota_ceo: row.nota_ceo || '',
    hecho: !!row.hecho,
    hecho_por: row.hecho_por || '',
    hecho_at: row.hecho_at || null,
    hecho_at_mx: formatMexico(row.hecho_at),
    batch_date: row.batch_date || null,
    status: row.status || (row.hecho ? 'done' : 'open'),
    created_at: row.created_at || null,
    created_at_mx: formatMexico(row.created_at),
    updated_at: row.updated_at || null,
    updated_at_mx: formatMexico(row.updated_at),
  };
}

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS ceo_tasks (
      id               SERIAL PRIMARY KEY,
      contact_id       TEXT,
      phone            TEXT,
      phone_normalized TEXT,
      name             TEXT,
      agent            TEXT,
      nota_ceo         TEXT,
      hecho            BOOLEAN DEFAULT FALSE,
      hecho_por        TEXT,
      hecho_at         TIMESTAMPTZ,
      batch_date       DATE,
      status           TEXT DEFAULT 'open',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ceo_tasks_phone_norm ON ceo_tasks(phone_normalized)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ceo_tasks_contact ON ceo_tasks(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ceo_tasks_agent ON ceo_tasks(agent)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ceo_tasks_status ON ceo_tasks(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ceo_tasks_batch ON ceo_tasks(batch_date)`;
}

async function findOpenTask(sql, phoneNorm, contactId) {
  if (phoneNorm) {
    const byPhone = await sql`
      SELECT * FROM ceo_tasks
      WHERE status = 'open' AND phone_normalized = ${phoneNorm}
      ORDER BY updated_at DESC
      LIMIT 1`;
    if (byPhone.length) return byPhone[0];
  }
  if (contactId) {
    const byId = await sql`
      SELECT * FROM ceo_tasks
      WHERE status = 'open' AND contact_id = ${contactId}
      ORDER BY updated_at DESC
      LIMIT 1`;
    if (byId.length) return byId[0];
  }
  return null;
}

async function listTasks(sql, agent, status) {
  const ag = normalizeAgent(agent);
  const st = String(status || 'open').toLowerCase();
  if (ag && st !== 'all') {
    return sql`
      SELECT * FROM ceo_tasks
      WHERE agent = ${ag} AND status = ${st}
      ORDER BY hecho ASC, updated_at DESC
      LIMIT 500`;
  }
  if (ag) {
    return sql`
      SELECT * FROM ceo_tasks
      WHERE agent = ${ag}
      ORDER BY hecho ASC, updated_at DESC
      LIMIT 500`;
  }
  if (st !== 'all') {
    return sql`
      SELECT * FROM ceo_tasks
      WHERE status = ${st}
      ORDER BY hecho ASC, updated_at DESC
      LIMIT 500`;
  }
  return sql`
    SELECT * FROM ceo_tasks
    ORDER BY hecho ASC, updated_at DESC
    LIMIT 500`;
}

async function handleUpsert(sql, body) {
  const phoneRaw = String(body.phone || '').trim();
  const phoneNorm = normalizePhone(phoneRaw) || normalizePhone(body.phone_normalized);
  const contactId = String(body.contact_id || '').trim();
  const incoming = String(body.nota_ceo || body.note || '').trim();
  if (!phoneNorm && !contactId) {
    return badRequest('phone or contact_id required');
  }
  if (!incoming) {
    return badRequest('nota_ceo is required');
  }

  const agent = normalizeAgent(body.agent);
  const name = String(body.name || '').trim();
  const batchDate = String(body.batch_date || mexicoDate()).trim() || mexicoDate();
  const existing = await findOpenTask(sql, phoneNorm, contactId);
  const newNota = appendNotaCeo(existing ? existing.nota_ceo : '', incoming);

  if (existing) {
    const nextAgent = agent || existing.agent || '';
    const nextName = name || existing.name || '';
    const nextContact = contactId || existing.contact_id || '';
    const nextPhone = phoneRaw || existing.phone || '';
    const nextPhoneNorm = phoneNorm || existing.phone_normalized || '';
    const updated = await sql`
      UPDATE ceo_tasks SET
        nota_ceo = ${newNota},
        name = ${nextName},
        contact_id = ${nextContact},
        phone = ${nextPhone},
        phone_normalized = ${nextPhoneNorm},
        agent = ${nextAgent},
        batch_date = ${batchDate},
        updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *`;
    return ok({ status: 'ok', action: 'appended', task: serializeTask(updated[0]) });
  }

  const inserted = await sql`
    INSERT INTO ceo_tasks
      (contact_id, phone, phone_normalized, name, agent, nota_ceo, hecho, batch_date, status)
    VALUES
      (${contactId}, ${phoneRaw}, ${phoneNorm}, ${name}, ${agent}, ${newNota},
       FALSE, ${batchDate}, 'open')
    RETURNING *`;
  return ok({ status: 'ok', action: 'created', task: serializeTask(inserted[0]) });
}

async function handleHecho(sql, body) {
  const id = parseInt(body.id, 10);
  const phoneNorm = normalizePhone(body.phone || body.phone_normalized);
  const hechoPor = String(body.hecho_por || body.agent || 'agente').trim() || 'agente';

  let current = null;
  if (id) {
    const rows = await sql`SELECT * FROM ceo_tasks WHERE id = ${id} LIMIT 1`;
    current = rows[0] || null;
  } else if (phoneNorm) {
    current = await findOpenTask(sql, phoneNorm, '');
  }
  if (!current) return badRequest('open task not found');

  const updated = await sql`
    UPDATE ceo_tasks SET
      hecho = TRUE,
      hecho_por = ${hechoPor},
      hecho_at = NOW(),
      status = 'done',
      updated_at = NOW()
    WHERE id = ${current.id}
    RETURNING *`;
  return ok({ status: 'ok', action: 'hecho', task: serializeTask(updated[0]) });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const sql = db();
    await ensureTable(sql);

    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};
      const rows = await listTasks(sql, qs.agent, qs.status);
      return ok({
        status: 'ok',
        tasks: (rows || []).map(serializeTask),
      });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Use GET or POST' });
    }

    const body = parseBody(event);
    const action = String(body.action || 'upsert').toLowerCase();

    if (action === 'hecho' || action === 'done') {
      return handleHecho(sql, body);
    }

    if (action === 'upsert' || action === 'note' || action === 'append') {
      const auth = requireAuth(event);
      if (!auth.ok) return unauthorized(auth.error);
      return handleUpsert(sql, body);
    }

    return badRequest('Unknown action. Use upsert or hecho');
  } catch (err) {
    return serverError(err);
  }
};

exports.normalizeAgent = normalizeAgent;
exports.appendNotaCeo = appendNotaCeo;
exports.mexicoStamp = mexicoStamp;
exports.mexicoDate = mexicoDate;
exports.formatMexico = formatMexico;
exports.serializeTask = serializeTask;
