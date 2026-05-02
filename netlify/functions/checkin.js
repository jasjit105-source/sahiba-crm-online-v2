// =====================================================================
// /api/checkin — log agent actions (✅ Called / 💬 Messaged / ❌ / 📅)
// =====================================================================
// No auth required so any agent can use it (the frontend has the password gate).
// =====================================================================

const { db, preflight, ok, badRequest, parseBody, serverError } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return badRequest('Use POST');

  try {
    const sql = db();
    await sql`
      CREATE TABLE IF NOT EXISTS checkins (
        id SERIAL PRIMARY KEY,
        agent TEXT, contact_id TEXT, name TEXT, phone TEXT,
        action TEXT, notes TEXT, score TEXT, priority TEXT,
        city TEXT, lifecycle TEXT,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      )`;

    const b = parseBody(event);
    await sql`
      INSERT INTO checkins
        (agent, contact_id, name, phone, action, notes, score, priority, city, lifecycle)
      VALUES
        (${b.agent || ''}, ${b.contactId || ''}, ${b.name || ''}, ${b.phone || ''},
         ${b.action || ''}, ${b.notes || ''}, ${String(b.score || '')}, ${b.priority || ''},
         ${b.city || ''}, ${b.lifecycle || ''})
    `;
    return ok({ status: 'ok' });
  } catch (err) {
    console.error('Checkin error:', err);
    return ok({ status: 'error', error: err.message });
  }
};
