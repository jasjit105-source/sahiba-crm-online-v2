// =====================================================================
// /api/import-log — admin-only: list upload history
// =====================================================================
// Returns: { status: 'ok', entries: [...] }
// Each entry: { id, kind, source, upload_id, chunk_index, total_chunks,
//               rows_total, rows_inserted, rows_skipped, status,
//               details, performed_at }
//
// Also: aggregate "uploads" (group chunks under their upload_id) so the
// frontend can show one row per upload session.
// =====================================================================

const { db, preflight, requireAuth, ok, unauthorized, CORS_HEADERS } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  // Admin only — agents shouldn't see upload events
  const auth = requireAuth(event);
  if (!auth.ok) return unauthorized(auth.error);

  try {
    const sql = db();
    await sql`CREATE TABLE IF NOT EXISTS import_log (
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

    // Latest 200 events (raw)
    const entries = await sql`
      SELECT id, kind, source, upload_id, chunk_index, total_chunks,
             rows_total, rows_inserted, rows_skipped, status, details, performed_at
      FROM import_log
      ORDER BY performed_at DESC
      LIMIT 200
    `;

    // Aggregate by upload_id so the dashboard can show one row per upload
    const aggregated = await sql`
      SELECT
        COALESCE(upload_id, 'no-id-' || MIN(id)::TEXT) AS upload_id,
        kind,
        MIN(performed_at) AS started_at,
        MAX(performed_at) AS finished_at,
        SUM(rows_total)::int AS total_rows,
        SUM(rows_inserted)::int AS total_inserted,
        SUM(rows_skipped)::int AS total_skipped,
        COUNT(*)::int AS event_count,
        MAX(total_chunks) AS chunks_expected,
        BOOL_AND(status = 'ok') AS all_ok
      FROM import_log
      GROUP BY upload_id, kind
      ORDER BY MAX(performed_at) DESC
      LIMIT 50
    `;

    return ok({ status: 'ok', entries, aggregated });
  } catch (err) {
    console.error('Import-log error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ status: 'error', error: err.message }) };
  }
};
