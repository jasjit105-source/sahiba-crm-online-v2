// =====================================================================
// /api/customer-profile?phone=5512345678
// =====================================================================
// Returns the full Customer 360 view for a single phone:
//   - master record (city, beach city, tier, lapsed flag, etc.)
//   - last 5 purchases (most recent first)
//   - last 20 messages (most recent first)
//   - aggregated stats (avg order, order frequency)
//
// Used by:
//   - Agent profile panel (when clicking a contact in the CRM)
//   - AI prompt builder (briefing + draft message)
// =====================================================================

const { db, preflight, ok, badRequest, serverError, normalizePhone } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    const rawPhone = url.searchParams.get('phone');
    if (!rawPhone) return badRequest('phone query parameter required');

    const phone = normalizePhone(rawPhone);
    if (!phone) return badRequest('phone could not be normalized to 10 digits');

    const sql = db();

    // Master customer record (may be null — phone in messages but never bought)
    const customerRows = await sql`
      SELECT * FROM customers WHERE phone = ${phone}
    `;
    const customer = customerRows[0] || null;

    // Last 5 purchases
    const purchases = await sql`
      SELECT
        purchase_date, store_code, vendedor, agent_name,
        ticket_id, product_code, product_name, category,
        qty, unit_price, line_total, payment_method
      FROM customer_purchases
      WHERE phone = ${phone}
      ORDER BY purchase_date DESC, ticket_id DESC
      LIMIT 5
    `;

    // Last 20 messages — match by phone via contact lookup is tricky because
    // messages table has contact_id, not phone. We need a join through the
    // contacts CSV blob, BUT we don't have a normalized contacts table yet.
    // For now, we return an empty array; the frontend can fill messages in
    // from the already-loaded messages dataset.
    //
    // TODO: When we add a `contacts` table (Phase 3b), join here.
    const messages = [];

    // Aggregate stats — average order value, days between orders
    let stats = null;
    if (customer && customer.total_orders > 0) {
      const span = await sql`
        SELECT
          COUNT(DISTINCT ticket_id) AS orders,
          AVG(per_ticket.tot)::numeric(12,2) AS avg_order,
          MIN(purchase_date) AS first_d,
          MAX(purchase_date) AS last_d
        FROM customer_purchases,
        LATERAL (
          SELECT SUM(line_total) AS tot
          FROM customer_purchases cp2
          WHERE cp2.phone = ${phone} AND cp2.ticket_id = customer_purchases.ticket_id
        ) per_ticket
        WHERE customer_purchases.phone = ${phone}
        GROUP BY ticket_id, per_ticket.tot
      `;
      // Compute avg days between orders
      let avgDaysBetweenOrders = null;
      if (customer.first_purchase_date && customer.last_purchase_date && customer.total_orders > 1) {
        const span = (new Date(customer.last_purchase_date) - new Date(customer.first_purchase_date)) / 86400000;
        avgDaysBetweenOrders = Math.round(span / (customer.total_orders - 1));
      }
      stats = {
        avg_order_mxn: customer.total_lifetime_mxn / customer.total_orders,
        avg_days_between_orders: avgDaysBetweenOrders,
      };
    }

    return ok({
      status: 'ok',
      phone,
      customer,
      purchases,
      messages,
      stats,
    });
  } catch (err) {
    return serverError(err);
  }
};
