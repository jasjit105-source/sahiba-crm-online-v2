// =====================================================================
// /api/customers-list — paginated customer list with stats
// =====================================================================
// Returns the full customers table for the Customers tab UI, plus
// aggregate stats for the filter pills and stat cards.
//
// ENRICHMENT (added 2026-05-04):
//   The SQL Server data has empty `city` (MOVS tables don't store
//   CustCiudad) and `favorite_agent` is only populated for purely
//   online vendedores (YAZMIN/YOANA_ECOMMERCE/E-COMMERCE/NANCY).
//   That leaves most customers with no agent/city visible in the UI.
//
//   We fix this by joining the latest Respond.io contacts CSV by phone:
//     - respond_agent  ← Assignee email mapped via AGENT_MAP
//     - respond_city   ← ciudad column (or fallback to LADA-from-phone)
//
//   The frontend prefers respond_* when SQL fields are empty.
//   This makes WhatsApp ownership visible across walk-in customers too.
//
// Query params:
//   limit    — max rows to return (default 1000, max 5000)
//
// Sorted by total_lifetime_mxn DESC by default.
// =====================================================================

const {
  db, preflight, ok, serverError,
  normalizePhone, mapAgent, AGENT_MAP, normalizeCityName,
} = require('./_shared');

// ---------------------------------------------------------------
// LADA → city/state lookup. Used as a fallback when the contacts
// CSV doesn't have a `ciudad` for a phone. Same data the dashboard
// already keeps client-side; keep this in sync if you change there.
// ---------------------------------------------------------------
const LADA_MAP = {
  // 3-digit area codes
  "222":["Puebla","Puebla"],"223":["Puebla","Puebla"],"224":["Puebla","Puebla"],
  "225":["Xalapa","Veracruz"],"227":["Puebla","Puebla"],"228":["Xalapa","Veracruz"],
  "229":["Xalapa","Veracruz"],"231":["Puebla","Puebla"],"238":["Puebla","Puebla"],
  "246":["Tlaxcala","Tlaxcala"],"248":["Puebla","Puebla"],"249":["Puebla","Puebla"],
  "271":["Xalapa","Veracruz"],"272":["Xalapa","Veracruz"],"273":["Xalapa","Veracruz"],
  "274":["Oaxaca de Juárez","Oaxaca"],"281":["Oaxaca de Juárez","Oaxaca"],
  "287":["Oaxaca de Juárez","Oaxaca"],"294":["Xalapa","Veracruz"],
  "311":["Tepic","Nayarit"],"312":["Colima","Colima"],"314":["Colima","Colima"],
  "322":["Puerto Vallarta","Jalisco"],"341":["Guadalajara","Jalisco"],
  "351":["Morelia","Michoacán"],"352":["Morelia","Michoacán"],
  "411":["Guanajuato","Guanajuato"],"414":["Querétaro","Querétaro"],
  "415":["Guanajuato","Guanajuato"],"442":["Querétaro","Querétaro"],
  "443":["Morelia","Michoacán"],"444":["San Luis Potosí","San Luis Potosí"],
  "449":["Aguascalientes","Aguascalientes"],"461":["Guanajuato","Guanajuato"],
  "462":["Guanajuato","Guanajuato"],"472":["Guanajuato","Guanajuato"],
  "477":["Guanajuato","Guanajuato"],"492":["Zacatecas","Zacatecas"],
  "612":["La Paz","Baja California Sur"],"614":["Chihuahua","Chihuahua"],
  "624":["Los Cabos","Baja California Sur"],"662":["Hermosillo","Sonora"],
  "664":["Tijuana","Baja California"],"667":["Culiacán","Sinaloa"],
  "669":["Mazatlán","Sinaloa"],"686":["Mexicali","Baja California"],
  "722":["Toluca de Lerdo","Estado de México"],"727":["Chilpancingo de los Bravo","Guerrero"],
  "732":["Chilpancingo de los Bravo","Guerrero"],"733":["Chilpancingo de los Bravo","Guerrero"],
  "744":["Acapulco","Guerrero"],"747":["Chilpancingo de los Bravo","Guerrero"],
  "754":["Zihuatanejo","Guerrero"],"762":["Chilpancingo de los Bravo","Guerrero"],
  "771":["Pachuca de Soto","Hidalgo"],"777":["Cuernavaca","Morelos"],
  "782":["Xalapa","Veracruz"],"783":["Xalapa","Veracruz"],"785":["Xalapa","Veracruz"],
  "833":["Tampico","Tamaulipas"],"844":["Saltillo","Coahuila"],
  "867":["Nuevo Laredo","Tamaulipas"],"871":["Torreón","Coahuila"],
  "913":["Villahermosa","Tabasco"],"914":["Villahermosa","Tabasco"],
  "916":["Tuxtla Gutiérrez","Chiapas"],"933":["Villahermosa","Tabasco"],
  "938":["San Francisco de Campeche","Campeche"],"951":["Oaxaca de Juárez","Oaxaca"],
  "954":["Oaxaca de Juárez","Oaxaca"],"958":["Oaxaca de Juárez","Oaxaca"],
  "961":["Tuxtla Gutiérrez","Chiapas"],"967":["Tuxtla Gutiérrez","Chiapas"],
  "969":["Mérida","Yucatán"],"981":["San Francisco de Campeche","Campeche"],
  "983":["Chetumal","Quintana Roo"],"984":["Playa del Carmen","Quintana Roo"],
  "987":["Cozumel","Quintana Roo"],"993":["Villahermosa","Tabasco"],
  "997":["Mérida","Yucatán"],"998":["Cancún","Quintana Roo"],
  "999":["Mérida","Yucatán"],
  // 2-digit area codes (covers metros)
  "33":["Guadalajara","Jalisco"],"55":["Ciudad de México","CDMX"],
  "81":["Monterrey","Nuevo León"],
};

function ladaLookup(phone10) {
  if (!phone10 || phone10.length !== 10) return null;
  const a3 = phone10.slice(0, 3);
  if (LADA_MAP[a3]) return { city: LADA_MAP[a3][0], state: LADA_MAP[a3][1] };
  const a2 = phone10.slice(0, 2);
  if (LADA_MAP[a2]) return { city: LADA_MAP[a2][0], state: LADA_MAP[a2][1] };
  return null;
}

// ---------------------------------------------------------------
// Build a phone → {agent, city} index from the latest contacts CSV.
// Stored in csv_blobs (kind='contacts'). We parse it once per request.
//
// Contacts CSV columns vary by Respond.io export, but always include:
//   ContactID, FirstName, LastName, PhoneNumber, Email, Country, Language,
//   Tags, Status, Lifecycle, Assignee, LastInteractionTime,
//   DateTimeCreated, Channels, ciudad, ...
// ---------------------------------------------------------------
function parseCsvLine(line) {
  // Lightweight CSV parser handling quoted fields with embedded commas.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function buildContactsIndex() {
  const sql = db();
  let rows;
  try {
    rows = await sql`
      SELECT csv_text FROM csv_blobs
      WHERE kind = 'contacts'
      ORDER BY uploaded_at DESC LIMIT 1
    `;
  } catch (e) {
    return new Map(); // table missing or empty — silently skip enrichment
  }
  if (!rows.length || !rows[0].csv_text) return new Map();

  const csv = rows[0].csv_text;
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return new Map();

  const headers = parseCsvLine(lines[0]).map(s => s.replace(/^"|"$/g, '').trim().toLowerCase());
  const phoneIdx = (() => {
    for (const k of ['phonenumber', 'phone', 'phone_number', 'mobile']) {
      const i = headers.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  })();
  const assigneeIdx = (() => {
    for (const k of ['assignee', 'assigned agent']) {
      const i = headers.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  })();
  const cityIdx = (() => {
    for (const k of ['ciudad', 'city']) {
      const i = headers.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  })();

  const idx = new Map();
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const cells = parseCsvLine(ln);
    const phoneRaw = phoneIdx >= 0 ? cells[phoneIdx] : '';
    const phone = normalizePhone(phoneRaw);
    if (!phone) continue;
    const assignee = assigneeIdx >= 0 ? (cells[assigneeIdx] || '').trim() : '';
    const city = cityIdx >= 0 ? (cells[cityIdx] || '').trim() : '';
    const agent = mapAgent(assignee); // returns 'Jazmin'|'Nancy'|'Yoana'|'Unassigned'
    // Only override if we got something useful — Unassigned is a real signal
    // but empty assignee shouldn't blow away anything.
    idx.set(phone, {
      agent: assignee ? agent : null,   // null → caller falls back to favorite_agent
      city: city || null,
    });
  }
  return idx;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const url = new URL(event.rawUrl || `http://x${event.path}?${event.rawQuery || ''}`);
    const limit = Math.max(50, Math.min(5000, parseInt(url.searchParams.get('limit') || '1000', 10)));

    const sql = db();

    // ---- 1. SQL-side customers (existing query, unchanged) ----
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

    // ---- 2. Build contacts index from latest Respond.io upload ----
    const contactsIdx = await buildContactsIndex();

    // ---- 3. Enrich each customer with respond_agent + respond_city ----
    // We DON'T overwrite favorite_agent / city — we add new fields and let
    // the frontend fall back. That way SQL-derived data is always primary.
    //
    // IMPORTANT: We build a NEW array of plain objects rather than mutating
    // the rows from Neon. The serverless driver sometimes returns rows that
    // can't be extended in place (depending on driver version), which would
    // silently drop our added properties when JSON.stringify runs.
    const agentCounts = { Jazmin: 0, Nancy: 0, Yoana: 0, Unassigned: 0 };
    const enrichedCustomers = customers.map((row) => {
      // Spread into a new plain object so all original fields are preserved
      // and new fields can definitely be added.
      const c = { ...row };
      const enrich = c.phone ? contactsIdx.get(c.phone) : null;
      let respondAgent = enrich ? enrich.agent : null;
      let respondCity = enrich ? enrich.city : null;

      // If we still don't have a city, fall back to LADA lookup (first 3
      // digits of the 10-digit Mexican phone).
      if (!respondCity && (!c.city || String(c.city).trim() === '')) {
        const lada = ladaLookup(c.phone);
        if (lada) respondCity = lada.city;
      }

      c.respond_agent = respondAgent;
      c.respond_city = respondCity;

      // Effective agent for stats counts: respond_agent → favorite_agent → Unassigned
      const effectiveAgent = respondAgent || c.favorite_agent || 'Unassigned';
      if (Object.prototype.hasOwnProperty.call(agentCounts, effectiveAgent)) {
        agentCounts[effectiveAgent]++;
      } else {
        agentCounts.Unassigned++;
      }
      c.effective_agent = effectiveAgent;
      return c;
    });

    // ---- 4. Aggregate stats (existing query + agent counts) ----
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
    const stats = statsRows[0] || {};
    stats.agent_jazmin = agentCounts.Jazmin;
    stats.agent_nancy = agentCounts.Nancy;
    stats.agent_yoana = agentCounts.Yoana;
    stats.agent_unassigned = agentCounts.Unassigned;

    return ok({
      status: 'ok',
      customers: enrichedCustomers,
      stats,
      returned: enrichedCustomers.length,
    });
  } catch (err) {
    return serverError(err);
  }
};
