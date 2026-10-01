-- =====================================================================
-- Sahiba CRM v2 — Neon Postgres schema
-- =====================================================================
-- Three tables, designed so the four phases of the buildout each only
-- TOUCH NEW COLUMNS or NEW TABLES, never invalidate existing data.
--
-- Phase 1 (current): leads, messages
-- Phase 3 (later):   sales_history
-- =====================================================================

-- ---------------------------------------------------------------------
-- LEADS — one row per contact (the people from Respond.io contacts CSV)
-- This is the source of truth that all 3 agents read from.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id              SERIAL PRIMARY KEY,
  contact_id      TEXT UNIQUE,           -- Respond.io ContactID
  phone           TEXT,                  -- digits only
  phone_normalized TEXT,                 -- 52XXXXXXXXXX (for matching SQL Server)
  name            TEXT,
  first_name      TEXT,
  last_name       TEXT,
  email           TEXT,
  city            TEXT,
  state           TEXT,
  country         TEXT,
  lifecycle       TEXT,
  assignee_email  TEXT,
  agent           TEXT,                  -- mapped: Nancy / Jazmin / Yoana / Unassigned
  tags            TEXT,
  status          TEXT,
  channels        TEXT,
  date_created    TIMESTAMPTZ,
  last_interaction TIMESTAMPTZ,

  -- Derived fields that the dashboard uses (refreshed on every upload)
  score           INTEGER DEFAULT 0,
  buy_score       INTEGER DEFAULT 0,
  priority        TEXT,                  -- P1 / P2 / P3 / PAID
  wholesale       BOOLEAN DEFAULT FALSE,
  payment_value   INTEGER DEFAULT 0,
  payment_formatted TEXT,
  paid            BOOLEAN DEFAULT FALSE, -- "pago recibido" detected
  imgs_in         INTEGER DEFAULT 0,
  imgs_out        INTEGER DEFAULT 0,
  msgs_in         INTEGER DEFAULT 0,
  msgs_out        INTEGER DEFAULT 0,
  last_msg_at     TIMESTAMPTZ,
  last_msg_text   TEXT,
  action          TEXT,                  -- "Confirm payment $X" etc.

  -- Agent-editable fields (preserved across uploads)
  notes           TEXT,
  follow_up_status TEXT,                 -- agent's status: Pendiente, Contactada, etc.
  whatsapp_sent   BOOLEAN DEFAULT FALSE,
  whatsapp_sent_at TIMESTAMPTZ,

  -- Bookkeeping
  imported_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_phone_norm ON leads(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads(agent);
CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
CREATE INDEX IF NOT EXISTS idx_leads_paid ON leads(paid);
CREATE INDEX IF NOT EXISTS idx_leads_lifecycle ON leads(lifecycle);
CREATE INDEX IF NOT EXISTS idx_leads_last_interaction ON leads(last_interaction);

-- ---------------------------------------------------------------------
-- MESSAGES — raw messages by contact
-- We store these so we can rebuild any time-window dashboard server-side
-- without re-uploading. ~50k rows for a normal Respond.io export.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  message_id      TEXT UNIQUE,           -- Respond.io Message ID
  contact_id      TEXT,
  datetime        TIMESTAMPTZ,
  message_type    TEXT,                  -- incoming / outgoing
  content_type    TEXT,                  -- text / attachment / image
  content_raw     TEXT,
  text            TEXT,                  -- extracted text
  sender_type     TEXT,
  channel_id      TEXT,
  imported_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_datetime ON messages(datetime);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);

-- ---------------------------------------------------------------------
-- SALES_HISTORY — purchase tickets from SQL Server (MOVS_CIRCUNVALACION)
-- Filled by Phase 3 sync function. One row per ticket-line.
-- We aggregate to per-customer in queries; storing line-level lets us
-- show "what they bought" later if you want.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_history (
  id              BIGSERIAL PRIMARY KEY,
  store           TEXT,                  -- 'Cercu' for now
  vendedor        TEXT,                  -- e.g. 'YAZMIN'
  ticket          TEXT,                  -- NO_REFEREN
  fecha           DATE,
  articulo        TEXT,
  descripcion     TEXT,
  linea           TEXT,
  cantidad        NUMERIC,
  precio_venta    NUMERIC,
  line_amount     NUMERIC,               -- cantidad * precio_venta, rounded
  cust_phone      TEXT,                  -- raw from SQL Server
  cust_phone_normalized TEXT,            -- normalized for matching
  cust_cliente    TEXT,
  cust_guia       TEXT,
  cust_pago       TEXT,
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ticket, articulo, store)        -- prevents double-insert on re-sync
);

CREATE INDEX IF NOT EXISTS idx_sales_phone_norm ON sales_history(cust_phone_normalized);
CREATE INDEX IF NOT EXISTS idx_sales_fecha ON sales_history(fecha);
CREATE INDEX IF NOT EXISTS idx_sales_ticket ON sales_history(ticket);

-- ---------------------------------------------------------------------
-- CEO_TASKS — morning notes from the shop owner (Jessie / CEO)
-- Isolated from leads.notes / follow_up_status. Agents mark Hecho here.
-- Matching is by phone_normalized and/or contact_id. Notes are APPENDED
-- with an America/Mexico_City timestamp — never overwritten.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ceo_tasks (
  id               SERIAL PRIMARY KEY,
  contact_id       TEXT,
  phone            TEXT,
  phone_normalized TEXT,
  name             TEXT,
  agent            TEXT,                  -- jazmin | nancy | yoana
  nota_ceo         TEXT,
  hecho            BOOLEAN DEFAULT FALSE,
  hecho_por        TEXT,
  hecho_at         TIMESTAMPTZ,
  batch_date       DATE,
  status           TEXT DEFAULT 'open',   -- open | done
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ceo_tasks_phone_norm ON ceo_tasks(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_ceo_tasks_contact ON ceo_tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_ceo_tasks_agent ON ceo_tasks(agent);
CREATE INDEX IF NOT EXISTS idx_ceo_tasks_status ON ceo_tasks(status);
CREATE INDEX IF NOT EXISTS idx_ceo_tasks_batch ON ceo_tasks(batch_date);

-- ---------------------------------------------------------------------
-- IMPORT_LOG — track every upload/sync so admin can see history
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_log (
  id              SERIAL PRIMARY KEY,
  kind            TEXT,                  -- 'csv_upload' / 'sql_sync'
  source          TEXT,                  -- filename or table name
  rows_total      INTEGER,
  rows_inserted   INTEGER,
  rows_updated    INTEGER,
  rows_skipped    INTEGER,
  details         JSONB,
  performed_at    TIMESTAMPTZ DEFAULT NOW()
);
