// =====================================================================
// /api/sync-sales — pull SQL Server purchase data into Neon
// =====================================================================
// Endpoints:
//   POST /api/sync-sales              — admin-triggered full sync
//     body: { mode: 'full' | 'incremental', store?: 'TS0001'|'TS0002'|...|'all' }
//   GET  /api/sync-sales/status       — return last sync timestamps + stats
//
// Pulls from SQL Server (via ngrok tunnel) and writes into Neon:
//   - customer_purchases  (line-by-line history)
//   - customers           (one row per phone, denormalized for fast lookups)
//
// Phone is the master key. Style codes map to category via shared helper.
// City names are checked against beach city lookup.
//
// IMPORTANT: This function can take 5-30 minutes for full all-time sync.
// Netlify has a 26-second function timeout on the free plan, so we paginate
// and the client must call repeatedly with returned cursor until done=true.
// =====================================================================

const {
  db, preflight, ok, badRequest, serverError, parseBody, requireAuth,
  CORS_HEADERS, normalizePhone, beachCityInfo, normalizeCityName,
  categoryFromCode, vendedorToAgent, classifySalesChannel, STORE_INFO,
} = require('./_shared');

// SQL Server proxy config (read from env, fall back to known values)
const SQL_PROXY_URL  = process.env.SQL_PROXY_URL  || 'https://aggrievedly-spryest-hattie.ngrok-free.dev/V1/query';
const SQL_PROXY_AUTH = process.env.SQL_PROXY_AUTH || 'Sahiba_CZSfEghwaD4s';

// VIP & lapsed thresholds
const VIP_LIFETIME_MXN = 50000;
const VIP_ORDER_COUNT  = 15;
const REGULAR_LIFETIME_MXN = 10000;
const LAPSED_DAYS = 60;

// Hard timeout safety: stop pulling pages after this many ms,
// return cursor so client can resume on next call.
const FUNCTION_BUDGET_MS = 22000;
const PAGE_SIZE = 5000;

// ---------- schema ----------
async function ensureSchema() {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS customer_purchases (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    purchase_date DATE,
    store_code TEXT,
    vendedor TEXT,
    agent_name TEXT,
    sales_channel TEXT,                -- 'agent_online' or 'walkin'
    ticket_id TEXT,
    product_code TEXT,
    product_name TEXT,
    category TEXT,
    qty INTEGER,
    unit_price NUMERIC(12,2),
    line_total NUMERIC(12,2),
    payment_method TEXT,
    lead_source TEXT,
    raw_customer_name TEXT,
    raw_city TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_code, ticket_id, product_code, phone)
  )`;
  // For older databases, ensure column exists
  await sql`ALTER TABLE customer_purchases ADD COLUMN IF NOT EXISTS sales_channel TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_phone ON customer_purchases(phone)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_date  ON customer_purchases(purchase_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_channel ON customer_purchases(sales_channel)`;

  await sql`CREATE TABLE IF NOT EXISTS customers (
    phone TEXT PRIMARY KEY,
    name TEXT,
    city TEXT,
    state TEXT,
    is_beach_city BOOLEAN DEFAULT FALSE,
    city_priority_score INTEGER,
    -- aggregate purchase stats
    total_orders INTEGER DEFAULT 0,
    total_lifetime_mxn NUMERIC(14,2) DEFAULT 0,
    -- channel breakdown
    total_online_orders INTEGER DEFAULT 0,
    total_online_mxn NUMERIC(14,2) DEFAULT 0,
    total_walkin_orders INTEGER DEFAULT 0,
    total_walkin_mxn NUMERIC(14,2) DEFAULT 0,
    -- date stats
    first_purchase_date DATE,
    last_purchase_date DATE,
    days_since_last_purchase INTEGER,
    favorite_category TEXT,
    favorite_product TEXT,
    favorite_store TEXT,
    favorite_vendedor TEXT,
    favorite_agent TEXT,
    favorite_payment TEXT,
    top_lead_source TEXT,
    -- enriched flags
    buyer_tier TEXT,           -- VIP / Regular / Casual / Lead
    is_lapsed BOOLEAN DEFAULT FALSE,
    -- timestamps
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  // Backfill columns for older databases
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_online_orders INTEGER DEFAULT 0`;
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_online_mxn NUMERIC(14,2) DEFAULT 0`;
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_walkin_orders INTEGER DEFAULT 0`;
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_walkin_mxn NUMERIC(14,2) DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS idx_customers_lapsed ON customers(is_lapsed) WHERE is_lapsed = TRUE`;
  await sql`CREATE INDEX IF NOT EXISTS idx_customers_tier ON customers(buyer_tier)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_customers_beach ON customers(is_beach_city) WHERE is_beach_city = TRUE`;

  await sql`CREATE TABLE IF NOT EXISTS sync_state (
    sync_key TEXT PRIMARY KEY,
    last_run_at TIMESTAMPTZ,
    last_cursor TEXT,
    rows_synced INTEGER DEFAULT 0,
    status TEXT,
    error_message TEXT
  )`;
}

// ---------- SQL Server proxy ----------
async function querySql(query) {
  const r = await fetch(SQL_PROXY_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SQL_PROXY_AUTH,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`SQL proxy ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  // Proxy returns either { rows: [...] } or array directly — normalize
  if (Array.isArray(data)) return data;
  if (data.rows) return data.rows;
  if (data.recordset) return data.recordset;
  if (data.data) return data.data;
  return [];
}

// ---------- store-specific page fetch ----------
//
// Pull a page of purchase rows from a single MOVS_* table.
// Uses NO_REFEREN as the deterministic offset cursor (numeric ticket id).
async function fetchStorePage(storeCode, sinceTicketId, limit) {
  const info = STORE_INFO[storeCode];
  if (!info) throw new Error('Unknown store: ' + storeCode);

  // We pull all purchase lines (each NO_REFEREN can have multiple style codes).
  // Customer fields: CustCliente, CustPhone, CustCiudad (if present), CustGuia (lead source).
  // Payment: PAGO2.  Item: Style/Product/Cantidad/Precio_Venta.
  //
  // CustCiudad column may not exist in all tables — we handle missing columns
  // gracefully by trying common variants and using NULL when missing.
  const since = parseInt(sinceTicketId || '0', 10) || 0;
  const lim = Math.max(100, Math.min(10000, limit || PAGE_SIZE));

  // Sync ALL purchases with phone numbers, no vendedor filter.
  // Channel attribution (online vs walk-in) is computed at write-time
  // from the vendedor + date via classifySalesChannel().
  //
  // Cercu  (TS0002): only TK movements (real sales, not returns)
  // Leona  (TS0001): require CustCliente non-empty (skip system rows)
  let storeFilter;
  if (storeCode === 'TS0001') {
    storeFilter = `CustCliente IS NOT NULL AND CustCliente <> ''`;
  } else if (storeCode === 'TS0002') {
    storeFilter = `Movimiento = 'TK'`;
  } else {
    return [];
  }

  const q = `
    SELECT TOP ${lim}
      NO_REFEREN  AS ticket_id,
      Fecha       AS purchase_date,
      Vendedor    AS vendedor,
      Articulo    AS product_code,
      Descripcion AS product_name,
      Marca       AS product_brand,
      Cantidad    AS qty,
      Precio_Venta AS unit_price,
      PAGO2       AS payment_method,
      CustCliente AS customer_name,
      CustPhone   AS phone,
      CustGUIA    AS lead_source
    FROM ${info.table}
    WHERE CAST(NO_REFEREN AS BIGINT) > ${since}
      AND CustPhone IS NOT NULL
      AND CustPhone <> ''
      AND ${storeFilter}
    ORDER BY CAST(NO_REFEREN AS BIGINT) ASC
  `.trim();

  const rows = await querySql(q);
  return rows;
}

// ---------- transform row → normalized purchase ----------
function transformRow(raw, storeCode) {
  const phone = normalizePhone(raw.phone || raw.CustPhone);
  if (!phone) return null;

  // Articulo column has style codes in formats like:
  //   "2063VE-UNVA"      → strip dash suffix → "2063VE"
  //   "24/9133VE-UNVA"   → strip prefix and suffix → "9133VE"
  //   "8010BA"           → already clean
  // Final stored code is the part after the last "/" and before the first "-".
  const rawCode = (raw.product_code || raw.Articulo || '').trim();
  let productCode = rawCode.split('-')[0];          // drop -UNVA suffix
  if (productCode.includes('/')) {
    productCode = productCode.split('/').pop();     // drop 24/ prefix
  }
  productCode = productCode.trim();
  const category = categoryFromCode(productCode);

  const vendedor = (raw.vendedor || raw.Vendedor || '').trim();
  const agent = vendedorToAgent(vendedor);
  const purchaseDate = raw.purchase_date || raw.Fecha || null;
  const salesChannel = classifySalesChannel(vendedor, purchaseDate);
  const qty = parseFloat(raw.qty || raw.Cantidad || 0) || 0;
  const unit = parseFloat(raw.unit_price || raw.Precio_Venta || 0) || 0;

  // Combine description + marca for richest product name
  const desc = (raw.product_name || raw.Descripcion || '').trim();
  const brand = (raw.product_brand || raw.Marca || '').trim();
  const productName = desc || brand || '';

  return {
    phone,
    purchase_date: purchaseDate,
    store_code: storeCode,
    vendedor,
    agent_name: agent,
    sales_channel: salesChannel,
    ticket_id: String(raw.ticket_id || raw.NO_REFEREN || ''),
    product_code: productCode,
    product_name: productName,
    category,
    qty,
    unit_price: unit,
    line_total: qty * unit,
    payment_method: (raw.payment_method || raw.PAGO2 || '').trim(),
    lead_source: (raw.lead_source || raw.CustGUIA || '').trim(),
    raw_customer_name: (raw.customer_name || raw.CustCliente || '').trim(),
    raw_city: '',
  };
}

// ---------- bulk insert (UNNEST) ----------
async function insertPurchases(rows) {
  if (!rows.length) return 0;
  const sql = db();

  // Insert in batches of 500 to stay under PostgreSQL parameter limits
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const phones = slice.map(r => r.phone);
    const dates = slice.map(r => r.purchase_date);
    const stores = slice.map(r => r.store_code);
    const vends = slice.map(r => r.vendedor);
    const agents = slice.map(r => r.agent_name);
    const channels = slice.map(r => r.sales_channel);
    const tickets = slice.map(r => r.ticket_id);
    const codes = slice.map(r => r.product_code);
    const names = slice.map(r => r.product_name);
    const cats = slice.map(r => r.category);
    const qtys = slice.map(r => r.qty);
    const units = slice.map(r => r.unit_price);
    const totals = slice.map(r => r.line_total);
    const pays = slice.map(r => r.payment_method);
    const leads = slice.map(r => r.lead_source);
    const custNames = slice.map(r => r.raw_customer_name);
    const cities = slice.map(r => r.raw_city);

    const result = await sql`
      INSERT INTO customer_purchases (
        phone, purchase_date, store_code, vendedor, agent_name, sales_channel,
        ticket_id, product_code, product_name, category, qty, unit_price, line_total,
        payment_method, lead_source, raw_customer_name, raw_city
      )
      SELECT * FROM UNNEST(
        ${phones}::text[],
        ${dates}::date[],
        ${stores}::text[],
        ${vends}::text[],
        ${agents}::text[],
        ${channels}::text[],
        ${tickets}::text[],
        ${codes}::text[],
        ${names}::text[],
        ${cats}::text[],
        ${qtys}::numeric[],
        ${units}::numeric[],
        ${totals}::numeric[],
        ${pays}::text[],
        ${leads}::text[],
        ${custNames}::text[],
        ${cities}::text[]
      )
      ON CONFLICT (store_code, ticket_id, product_code, phone) DO NOTHING
      RETURNING id
    `;
    total += Array.isArray(result) ? result.length : 0;
  }
  return total;
}

// ---------- recompute customers summary ----------
//
// Single SQL pass that aggregates purchases per phone and upserts into customers.
// Runs after fresh purchase rows are inserted so the summary stays accurate.
async function recomputeCustomers() {
  const sql = db();

  // Build aggregation in one query, then upsert.
  // We compute everything in PostgreSQL because doing it in JS would require
  // shipping all rows to the function — way too much data for big customers.
  await sql`
    INSERT INTO customers (
      phone, name, city, total_orders, total_lifetime_mxn,
      total_online_orders, total_online_mxn,
      total_walkin_orders, total_walkin_mxn,
      first_purchase_date, last_purchase_date, days_since_last_purchase,
      favorite_category, favorite_product, favorite_store,
      favorite_vendedor, favorite_agent, favorite_payment, top_lead_source,
      buyer_tier, is_lapsed, last_synced_at
    )
    WITH base AS (
      SELECT
        phone,
        MAX(raw_customer_name) AS name,
        MAX(raw_city) AS city,
        COUNT(DISTINCT ticket_id) AS total_orders,
        SUM(line_total) AS total_lifetime_mxn,
        COUNT(DISTINCT CASE WHEN sales_channel = 'agent_online' THEN ticket_id END) AS online_orders,
        SUM(CASE WHEN sales_channel = 'agent_online' THEN line_total ELSE 0 END) AS online_mxn,
        COUNT(DISTINCT CASE WHEN sales_channel = 'walkin' THEN ticket_id END) AS walkin_orders,
        SUM(CASE WHEN sales_channel = 'walkin' THEN line_total ELSE 0 END) AS walkin_mxn,
        MIN(purchase_date) AS first_purchase_date,
        MAX(purchase_date) AS last_purchase_date
      FROM customer_purchases
      WHERE phone IS NOT NULL AND phone <> ''
      GROUP BY phone
    ),
    fav_cat AS (
      SELECT DISTINCT ON (phone) phone, category
      FROM customer_purchases
      WHERE category IS NOT NULL
      GROUP BY phone, category
      ORDER BY phone, COUNT(*) DESC
    ),
    fav_prod AS (
      SELECT DISTINCT ON (phone) phone, product_code
      FROM customer_purchases
      WHERE product_code IS NOT NULL AND product_code <> ''
      GROUP BY phone, product_code
      ORDER BY phone, COUNT(*) DESC
    ),
    fav_store AS (
      SELECT DISTINCT ON (phone) phone, store_code
      FROM customer_purchases
      WHERE store_code IS NOT NULL
      GROUP BY phone, store_code
      ORDER BY phone, COUNT(*) DESC
    ),
    fav_vend AS (
      SELECT DISTINCT ON (phone) phone, vendedor, agent_name
      FROM customer_purchases
      WHERE vendedor IS NOT NULL AND vendedor <> ''
        AND sales_channel = 'agent_online'   -- only count online agent for "favorite agent"
      GROUP BY phone, vendedor, agent_name
      ORDER BY phone, COUNT(*) DESC
    ),
    fav_pay AS (
      SELECT DISTINCT ON (phone) phone, payment_method
      FROM customer_purchases
      WHERE payment_method IS NOT NULL AND payment_method <> ''
      GROUP BY phone, payment_method
      ORDER BY phone, COUNT(*) DESC
    ),
    top_lead AS (
      SELECT DISTINCT ON (phone) phone, lead_source
      FROM customer_purchases
      WHERE lead_source IS NOT NULL AND lead_source <> ''
      GROUP BY phone, lead_source
      ORDER BY phone, COUNT(*) DESC
    )
    SELECT
      b.phone,
      b.name,
      b.city,
      b.total_orders,
      b.total_lifetime_mxn,
      b.online_orders,
      b.online_mxn,
      b.walkin_orders,
      b.walkin_mxn,
      b.first_purchase_date,
      b.last_purchase_date,
      (CURRENT_DATE - b.last_purchase_date) AS days_since_last_purchase,
      fc.category AS favorite_category,
      fp.product_code AS favorite_product,
      fs.store_code AS favorite_store,
      fv.vendedor AS favorite_vendedor,
      fv.agent_name AS favorite_agent,
      fpay.payment_method AS favorite_payment,
      tl.lead_source AS top_lead_source,
      CASE
        WHEN b.total_lifetime_mxn >= ${VIP_LIFETIME_MXN} OR b.total_orders >= ${VIP_ORDER_COUNT} THEN 'VIP'
        WHEN b.total_lifetime_mxn >= ${REGULAR_LIFETIME_MXN} THEN 'Regular'
        ELSE 'Casual'
      END AS buyer_tier,
      (CURRENT_DATE - b.last_purchase_date) > ${LAPSED_DAYS} AS is_lapsed,
      NOW() AS last_synced_at
    FROM base b
    LEFT JOIN fav_cat   fc   ON b.phone = fc.phone
    LEFT JOIN fav_prod  fp   ON b.phone = fp.phone
    LEFT JOIN fav_store fs   ON b.phone = fs.phone
    LEFT JOIN fav_vend  fv   ON b.phone = fv.phone
    LEFT JOIN fav_pay   fpay ON b.phone = fpay.phone
    LEFT JOIN top_lead  tl   ON b.phone = tl.phone
    ON CONFLICT (phone) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, customers.name),
      city = COALESCE(EXCLUDED.city, customers.city),
      total_orders = EXCLUDED.total_orders,
      total_lifetime_mxn = EXCLUDED.total_lifetime_mxn,
      total_online_orders = EXCLUDED.total_online_orders,
      total_online_mxn = EXCLUDED.total_online_mxn,
      total_walkin_orders = EXCLUDED.total_walkin_orders,
      total_walkin_mxn = EXCLUDED.total_walkin_mxn,
      first_purchase_date = EXCLUDED.first_purchase_date,
      last_purchase_date = EXCLUDED.last_purchase_date,
      days_since_last_purchase = EXCLUDED.days_since_last_purchase,
      favorite_category = EXCLUDED.favorite_category,
      favorite_product = EXCLUDED.favorite_product,
      favorite_store = EXCLUDED.favorite_store,
      favorite_vendedor = EXCLUDED.favorite_vendedor,
      favorite_agent = EXCLUDED.favorite_agent,
      favorite_payment = EXCLUDED.favorite_payment,
      top_lead_source = EXCLUDED.top_lead_source,
      buyer_tier = EXCLUDED.buyer_tier,
      is_lapsed = EXCLUDED.is_lapsed,
      last_synced_at = EXCLUDED.last_synced_at
  `;

  // Apply beach city flags using JS lookup (Postgres doesn't have our beach city map)
  // Pull all cities, compute flag, batch update.
  const cityRows = await sql`SELECT DISTINCT city FROM customers WHERE city IS NOT NULL AND city <> ''`;
  const updates = [];
  for (const { city } of cityRows) {
    const info = beachCityInfo(city);
    if (info) {
      updates.push({ city, priority: info.priority, state: info.state });
    } else {
      updates.push({ city, priority: null, state: null });
    }
  }

  // Apply updates one city at a time (cities are bounded — usually <500)
  for (const u of updates) {
    if (u.priority !== null) {
      await sql`
        UPDATE customers
        SET is_beach_city = TRUE,
            city_priority_score = ${u.priority},
            state = COALESCE(state, ${u.state})
        WHERE city = ${u.city}
      `;
    } else {
      await sql`
        UPDATE customers
        SET is_beach_city = FALSE,
            city_priority_score = NULL
        WHERE city = ${u.city}
      `;
    }
  }

  const total = await sql`SELECT COUNT(*)::int AS c FROM customers`;
  return total[0].c;
}

// ---------- sync state helpers ----------
async function getSyncState(key) {
  const sql = db();
  const r = await sql`SELECT * FROM sync_state WHERE sync_key = ${key}`;
  return r[0] || null;
}
async function setSyncState(key, fields) {
  const sql = db();
  const cur = fields.last_cursor != null ? String(fields.last_cursor) : null;
  await sql`
    INSERT INTO sync_state (sync_key, last_run_at, last_cursor, rows_synced, status, error_message)
    VALUES (${key}, NOW(), ${cur}, ${fields.rows_synced || 0}, ${fields.status || 'ok'}, ${fields.error_message || null})
    ON CONFLICT (sync_key) DO UPDATE SET
      last_run_at = NOW(),
      last_cursor = EXCLUDED.last_cursor,
      rows_synced = sync_state.rows_synced + EXCLUDED.rows_synced,
      status = EXCLUDED.status,
      error_message = EXCLUDED.error_message
  `;
}

// ---------- main handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    await ensureSchema();

    // GET /api/sync-sales/status — quick health check, no auth needed
    if (event.httpMethod === 'GET') {
      const sql = db();
      const states = await sql`SELECT * FROM sync_state ORDER BY sync_key`;
      const counts = await sql`SELECT
        (SELECT COUNT(*) FROM customer_purchases)::int AS purchases,
        (SELECT COUNT(*) FROM customer_purchases WHERE sales_channel = 'agent_online')::int AS online_purchases,
        (SELECT COUNT(*) FROM customer_purchases WHERE sales_channel = 'walkin')::int AS walkin_purchases,
        (SELECT COUNT(*) FROM customers)::int AS customers,
        (SELECT COUNT(*) FROM customers WHERE total_online_orders > 0)::int AS online_customers,
        (SELECT COUNT(*) FROM customers WHERE is_beach_city = TRUE)::int AS beach_customers,
        (SELECT COUNT(*) FROM customers WHERE buyer_tier = 'VIP')::int AS vip_customers,
        (SELECT COUNT(*) FROM customers WHERE is_lapsed = TRUE)::int AS lapsed_customers
      `;
      return ok({ status: 'ok', states, totals: counts[0] });
    }

    // POST — admin-triggered sync (auth required)
    const auth = requireAuth(event);
    if (!auth.ok) return { statusCode: auth.status, headers: CORS_HEADERS, body: JSON.stringify({ error: auth.error }) };

    const body = parseBody(event);
    // Only TS0001 (Leona = Nancy) and TS0002 (Cercu = Jazmin + Yoana) are tracked.
    // Lecumberri and Chinconcuac are not synced — those stores don't have our agents.
    const ALL_TRACKED_STORES = ['TS0001', 'TS0002'];
    const stores = body.store === 'all' || !body.store
      ? ALL_TRACKED_STORES
      : [body.store];
    const reset = body.reset === true; // optionally restart the cursor at 0

    const startTime = Date.now();
    let totalInserted = 0;
    let storesProcessed = [];
    let needsResume = false;

    for (const storeCode of stores) {
      const info = STORE_INFO[storeCode];
      if (!info) continue;

      const syncKey = 'sales_sync_' + storeCode;
      const state = reset ? null : await getSyncState(syncKey);
      let cursor = state ? state.last_cursor : null;
      let storeInserted = 0;
      let storeDone = false;

      while (Date.now() - startTime < FUNCTION_BUDGET_MS) {
        const rawRows = await fetchStorePage(storeCode, cursor, PAGE_SIZE);
        if (!rawRows.length) {
          storeDone = true;
          break;
        }
        const transformed = rawRows.map(r => transformRow(r, storeCode)).filter(Boolean);
        const inserted = await insertPurchases(transformed);
        storeInserted += inserted;
        totalInserted += inserted;

        // Update cursor to the highest ticket_id from this page
        const lastRow = rawRows[rawRows.length - 1];
        cursor = String(lastRow.ticket_id || lastRow.NO_REFEREN || cursor);

        if (rawRows.length < PAGE_SIZE) {
          // Page returned less than requested → end of table
          storeDone = true;
          break;
        }
      }

      await setSyncState(syncKey, {
        last_cursor: cursor,
        rows_synced: storeInserted,
        status: storeDone ? 'complete' : 'in_progress',
      });

      storesProcessed.push({
        store: storeCode,
        store_name: info.name,
        rows_inserted: storeInserted,
        cursor,
        done: storeDone,
      });

      if (!storeDone) {
        needsResume = true;
        break; // out of time, save progress, client can resume
      }
    }

    // Always recompute customer summary if we processed any stores,
    // even if 0 new rows. The customers table is derived from purchases
    // and may need refresh after backfills, classification fixes, etc.
    let customerCount = null;
    if (!needsResume && storesProcessed.length > 0) {
      try {
        customerCount = await recomputeCustomers();
      } catch (e) {
        console.error('recomputeCustomers failed:', e);
      }
    }

    return ok({
      status: 'ok',
      total_inserted: totalInserted,
      stores_processed: storesProcessed,
      needs_resume: needsResume,
      done: !needsResume,
      duration_ms: Date.now() - startTime,
      customer_count: customerCount,
    });
  } catch (err) {
    return serverError(err);
  }
};
