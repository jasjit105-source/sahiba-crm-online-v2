# Sahiba CRM v2 — Phase 1 + Phase 2

The existing Sahiba CRM dashboard, now wired up with **persistent Neon Postgres storage**, **chunked uploads** for large files, and an **Upload History log**.

## What's new in Phase 2

| Feature | What it does |
|---|---|
| **Append-only message storage** | Every upload accumulates messages into Neon. Messages are deduped by Message ID, so re-uploading the same export does no harm. |
| **Chunked upload** | The messages CSV is split into 3 MB chunks client-side and uploaded sequentially with a progress bar. Handles 50+ MB exports without hitting Netlify's 6 MB request limit. |
| **6-month rolling window** | After each upload, messages older than 6 months are auto-pruned (keeps Neon storage bounded). |
| **Upload History tab** | New admin-only "📜 Upload Log" tab in the navigation. Shows every upload session with timestamp, kind, row counts, success status, and chunk count. |
| **Window selector for messages** | The dashboard's `/api/data` endpoint now respects a `?days=N` query (default 90) to pull just the messages window the dashboard needs. |

## Project structure

```
sahiba-crm-final/
├── index.html                       # Dashboard (unchanged tabs + new Upload Log + chunked upload)
├── netlify.toml                     # Routes for /api/{data,upload,checkin,import-log,query,sales-sync}
├── package.json                     # @neondatabase/serverless
├── .gitignore
├── db/
│   └── schema.sql                   # Reference Postgres schema
└── netlify/functions/
    ├── _shared.js                   # DB, auth, CORS helpers
    ├── data.js                      # GET  /api/data         — read latest data
    ├── upload.js                    # POST /api/upload       — chunked upload (admin)
    ├── checkin.js                   # POST /api/checkin      — log agent actions
    ├── import-log.js                # GET  /api/import-log   — upload history (admin)
    └── query.js                     # POST /api/query        — SQL Server proxy (Phase 3)
```

## Database tables (Neon)

| Table | Purpose | Phase |
|---|---|---|
| `csv_blobs` | Latest contacts.csv snapshot (replaced on each upload) | 1 |
| `messages` | Append-only, deduped by `message_id`, pruned at 6 months | **2** |
| `known_contacts` | Tracks first-seen date for each contact ID (for "new contact" badge) | 1 |
| `checkins` | Agent action log (✅ / 💬 / ❌ / 📅) | 1 |
| `import_log` | Every upload + sync event, queryable by upload_id | **2** |
| `sales_history` | (Phase 3 — SQL Server sales mirror) | 3 |

## Setup

### 1. Push to GitHub and connect to Netlify

Same repo as Phase 1, just push the new commits.

### 2. Environment variables (no changes from Phase 1)

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgresql://...` (Neon connection string) |
| `APP_TOKEN` | `sahiba2026` |
| `SQL_NGROK_URL` | `https://aggrievedly-spryest-hattie.ngrok-free.dev` (Phase 3) |
| `SQL_API_TOKEN` | `Sahiba_CZSfEghwaD4s` (Phase 3) |

### 3. Daily workflow

| Who | URL | Password | Can upload? |
|---|---|---|---|
| **You (admin)** | `https://yoursite.netlify.app` | `1993` | ✅ Yes |
| Nancy | `https://yoursite.netlify.app?v=nancy` | none | ❌ No |
| Jazmin | `https://yoursite.netlify.app?v=jazmin` | none | ❌ No |
| Yoana | `https://yoursite.netlify.app?v=yoana` | none | ❌ No |

**Initial seeding (one-time, ~5 min):**
1. Export 6 months of messages from Respond.io (will be ~50 MB)
2. Open admin URL, drop both files
3. Click "📤 Upload & Update" — progress bar shows chunk-by-chunk
4. Done — Neon has 6 months of history

**Daily (~30 sec):**
1. Export last 24h from Respond.io (small, ~1 MB)
2. Drop, upload — finishes in one shot
3. New messages append; duplicates auto-skipped

**To verify uploads worked:**
- Click the new "📜 Upload Log" tab → see the timeline of every upload

## Architecture

```
                ┌──────────────────────────────────────────┐
                │  ADMIN BROWSER (Jessie)                  │
                │  • Sees all tabs + Upload Log            │
                │  • Can drop CSVs, click Upload           │
                │  • Upload splits messages.csv → chunks   │
                │  • Sequential POST /api/upload (with     │
                │    progress bar)                         │
                └────────────────┬─────────────────────────┘
                                 │
                ┌──────────────────────────────────────────┐
                │  AGENT BROWSER (Nancy / Jazmin / Yoana)  │
                │  • ?v=name URL → no password             │
                │  • Upload UI hidden                      │
                │  • GET /api/data on load                 │
                │  • Sees same dashboard, read-only data   │
                └────────────────┬─────────────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────────────┐
                │  NETLIFY FUNCTIONS                       │
                │  • data.js     reads contacts blob +     │
                │                rebuilds messages CSV     │
                │                from messages table       │
                │  • upload.js   appends rows, dedupes,    │
                │                logs every chunk          │
                │  • import-log  reads upload history      │
                │  • checkin     logs agent actions        │
                │  • query.js    proxy to SQL Server       │
                └────────────────┬─────────────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────────────┐
                │  NEON POSTGRES                           │
                │  • messages       (append-only, 6mo)     │
                │  • csv_blobs      (contacts snapshot)    │
                │  • known_contacts (new badge tracking)   │
                │  • import_log     (upload history)       │
                │  • checkins       (agent actions)        │
                │  • sales_history  (Phase 3)              │
                └──────────────────────────────────────────┘
```

## How chunked upload works

1. Frontend reads both files via FileReader
2. Contacts CSV (small, ~5 MB): single POST → server replaces snapshot
3. Messages CSV (large, ~15-50 MB): client splits into 3 MB chunks, each chunk gets the header row prepended
4. Sequential POST per chunk, progress bar updates after each
5. Server parses each chunk independently, batch-inserts 200 rows at a time, deduped by `message_id`
6. On the **last chunk**, server prunes anything older than 6 months
7. Each chunk logs a row in `import_log` with the same `upload_id` so you can group them in the Upload Log tab

## Phase 3 preview

Next phase will:
- Add `/api/sales-sync` function that paginates `MOVS_CIRCUNVALACION` year-by-year via the ngrok tunnel
- Pull ALL vendedores' sales (not just YAZMIN)
- Add a **"Customer Analysis"** tab showing each customer's lifetime spend, last purchase date, # visits, status (Active/Inactive)
- Inactive = no SQL purchase in 90 days
- Per-lead overlay: tiny badge on each row showing "💰 $4,200 across 3 visits, last seen 12d ago"

## Troubleshooting

**Upload says "Network Error" partway through:**
A single chunk failed. Click Upload again — the duplicates from the first attempt will be skipped, only the failed/missing chunks will reach the DB.

**Upload Log tab is empty after first upload:**
You may have uploaded with the legacy single-shot path (which still works for tiny files). Check Netlify function logs to confirm.

**Messages count in dashboard is lower than expected:**
The dashboard pulls `?days=90` by default. If you uploaded 6 months of history, you have it in Neon — change the dashboard's window selector to "6 months" to see all of it.

**6-month prune deleted too much:**
Edit `upload.js` line ~155 — change `INTERVAL '6 months'` to `INTERVAL '12 months'`.
