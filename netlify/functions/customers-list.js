// =====================================================================
// /api/customers-list — paginated customer list with stats
// =====================================================================
// Returns the full customers table for the Customers tab UI, plus
// aggregate stats for the filter pills and stat cards.
//
// Query params:
//   limit    — max rows to return (default 1000, max 5000)
//   filter   — optional: vip | lapsed | online
//
// Sorted by total_lifetime_mxn DESC by default.
// =====================================================================

const { db, preflight, ok, badRequest, serverError } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    const limit = Math.max(50, Math.min(5000, parseInt(url.searchParams.get('limit') || '1000', 10)));

    const sql = db();

    // Pull all customers with the columns the UI needs.
    // We don't paginate yet because total is small (<10k rows expected).
    const customers = await sql`
      SELECT
        phone, name, city, state,
        is_beach_city, city_priority_score,
        total_orders, total_lifetime_mxn,
        total_online_orders, total_online_mxn,
        total_walkin_orders, total_walkin_mxn,
        first_purchase_date, last_purchase_date, days_since_last_purchase,
        favorite_category, favorite_product, favorite_store,
        favorite_vendedor, favorite_agent, favorite_payment,
        top_lead_source,
        buyer_tier, is_lapsed
      FROM customers
      ORDER BY total_lifetime_mxn DESC NULLS LAST
      LIMIT ${limit}
    `;

    // Stats row for the dashboard tiles
    const statsRows = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE buyer_tier = 'VIP')::int AS vip,
        COUNT(*) FILTER (WHERE buyer_tier = 'Regular')::int AS regular,
        COUNT(*) FILTER (WHERE is_lapsed = TRUE)::int AS lapsed,
        COUNT(*) FILTER (WHERE total_online_orders > 0)::int AS online,
        COUNT(*) FILTER (WHERE total_walkin_orders > 0)::int AS walkin,
        COUNT(*) FILTER (WHERE is_beach_city = TRUE)::int AS beach,
        AVG(total_lifetime_mxn)::numeric(14,2) AS avg_lifetime,
        MAX(total_lifetime_mxn)::numeric(14,2) AS top_spender
      FROM customers
    `;

    return ok({
      status: 'ok',
      customers,
      stats: statsRows[0] || {},
      returned: customers.length,
    });
  } catch (err) {
    return serverError(err);
  }
};
