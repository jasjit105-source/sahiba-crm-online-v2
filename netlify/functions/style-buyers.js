// =====================================================================
// /api/style-buyers — who bought a style, how many pieces, total paid
// =====================================================================
// GET /api/style-buyers?style=517VE
//
// Matches the base style (everything before the first hyphen), so 517VE
// covers 517VE and every 517VE-<size/color> article. Reads from the Neon
// customer_purchases table (synced from SQL Server), joins the customers
// table for the display name, and returns one row per phone sorted by
// pieces bought (biggest buyer first).
// =====================================================================

const { db, preflight, ok, badRequest, serverError } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const raw = String((event.queryStringParameters || {}).style || '').trim().toUpperCase();
    const style = raw.replace(/[^A-Z0-9\-\.\/]/g, '');
    if (!style) return badRequest('style parameter required');
    const like = style + '-%';
    const sql = db();
    const buyers = await sql`
      SELECT cp.phone,
             COALESCE(NULLIF(MAX(c.name), ''), NULLIF(MAX(cp.raw_customer_name), ''), '') AS name,
             COALESCE(NULLIF(MAX(cp.agent_name), ''), '') AS agent,
             SUM(cp.qty)::int                      AS pieces,
             COUNT(DISTINCT cp.ticket_id)::int     AS tickets,
             ROUND(SUM(cp.line_total), 2)          AS amount,
             MIN(cp.purchase_date)                 AS first_buy,
             MAX(cp.purchase_date)                 AS last_buy
      FROM customer_purchases cp
      LEFT JOIN customers c ON c.phone = cp.phone
      WHERE cp.product_code = ${style} OR cp.product_code LIKE ${like}
      GROUP BY cp.phone
      ORDER BY SUM(cp.qty) DESC, SUM(cp.line_total) DESC`;
    const totals = {
      customers: buyers.length,
      pieces: buyers.reduce((s, b) => s + (+b.pieces || 0), 0),
      tickets: buyers.reduce((s, b) => s + (+b.tickets || 0), 0),
      amount: buyers.reduce((s, b) => s + (+b.amount || 0), 0),
    };
    return ok({ style, buyers, totals });
  } catch (e) {
    return serverError(e.message);
  }
};
