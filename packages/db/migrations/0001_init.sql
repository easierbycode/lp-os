-- 0001_init.sql — LP-OS consolidated schema (fresh database).
--
-- Provenance: union of data-pimp (db.ts + its migrations) and
-- tiktok-sample-tracker (src/lib/server/db.ts + supabase/migrations). The two
-- source apps shared one Neon database, so their samples/bundles/
-- inventory_transactions/sample_images definitions coincide; per-column tags
-- below use:
--   [both]            identical in data-pimp and tracker
--   [both 2026MMDD]   added by that shared migration date in both repos
--   [new]             introduced by LP-OS (docs/CONTRACTS.md "Database")
--
-- Redesigns decided in docs/CONTRACTS.md:
--   * every *_at audit column is promoted TEXT -> timestamptz; the @lp-os/db
--     module accepts ISO strings on write and returns ISO strings on read, so
--     ported callers are unaffected.
--   * inventory_transactions is renamed to `transactions` (reconciled name).
--   * transactions.created_at was TEXT DEFAULT TO_CHAR(NOW(),
--     'YYYY-MM-DD HH24:MI:SS') -> now timestamptz DEFAULT now().
--   * tracker's Supabase RLS policies are intentionally dropped: LP-OS talks
--     to Neon directly through reducer-style server code, no PostgREST layer.
--
-- Every statement is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING), so
-- re-running this file is safe; scripts/migrate.ts additionally records it in
-- schema_migrations. mod.ts ensureSchema() mirrors this file (see schema.ts;
-- test/schema_sync_test.ts asserts the two stay in sync).

-- ---------------------------------------------------------------------------
-- bundles — batch container for samples. Source: [both] (identical).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bundles (
  id         SERIAL PRIMARY KEY,                  -- [both]
  name       TEXT NOT NULL,                       -- [both]
  location   TEXT,                                -- [both]
  qr_code    TEXT,                                -- [both] scannable bundle code
  notes      TEXT,                                -- [both]
  created_at TIMESTAMPTZ DEFAULT now()            -- [both]
);

-- ---------------------------------------------------------------------------
-- samples — primary inventory. Source: [both] unless tagged otherwise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.samples (
  id                    SERIAL PRIMARY KEY,       -- [both]
  name                  TEXT NOT NULL,            -- [both]
  brand                 TEXT,                     -- [both] seller name
  location              TEXT,                     -- [both]
  qr_code               TEXT,                     -- [both] TikTok product id; join key to graylog_messages fields->>'product_id'
  picture_url           TEXT,                     -- [both]
  tiktok_affiliate_link TEXT,                     -- [both]
  fire_sale             TEXT,                     -- [both] non-exclusive badge, not a status
  status                TEXT NOT NULL DEFAULT 'available',  -- [both] available|checked_out|reserved|cleared_to_sell|discontinued|sold
  current_price         DOUBLE PRECISION,         -- [both]
  best_price            DOUBLE PRECISION,         -- [both]
  best_price_source     TEXT,                     -- [both]
  last_price_checked_at TIMESTAMPTZ,              -- [both; was TEXT -> timestamptz per CONTRACTS]
  bundle_id             INTEGER REFERENCES public.bundles(id) ON DELETE SET NULL,  -- [both]
  checked_out_at        TIMESTAMPTZ,              -- [both; was TEXT -> timestamptz]
  checked_in_at         TIMESTAMPTZ,              -- [both; was TEXT -> timestamptz]
  checked_out_to        TEXT,                     -- [both] creator handle (@…) or agency bucket
  sold_at               TIMESTAMPTZ,              -- [both 20260614; was TEXT -> timestamptz]
  sold_to               TEXT,                     -- [both 20260614] buyer name
  sold_price            DOUBLE PRECISION,         -- [both 20260614]
  notes                 TEXT,                     -- [both]
  c19                   TEXT,                     -- [both] legacy field, carried over verbatim
  related_upc           TEXT[],                   -- [both 20260615] other UPCs resolving to same product
  product_json          JSONB,                    -- [both 20260615] raw ScrapeCreators record (tracker caps at 8 KB app-side)
  quantity              INTEGER NOT NULL DEFAULT 1,  -- [both 20260703] unit count; re-scan increments
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()  -- [both]
);

-- ---------------------------------------------------------------------------
-- transactions — audit log. Source: [both] as `inventory_transactions`;
-- renamed to `transactions` per CONTRACTS [decided there].
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transactions (
  id             SERIAL PRIMARY KEY,              -- [both]
  action         TEXT NOT NULL,                   -- [both] check_out|check_in|agency_intake|sold|custom
  sample_id      INTEGER REFERENCES public.samples(id) ON DELETE SET NULL,  -- [both]
  bundle_id      INTEGER REFERENCES public.bundles(id) ON DELETE SET NULL,  -- [both]
  scanned_code   TEXT,                            -- [both] QR code / product id as scanned
  operator       TEXT,                            -- [both] user who performed the action
  checked_out_to TEXT,                            -- [both] creator / recipient
  notes          TEXT,                            -- [both] event summary / reason
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()  -- [both; was TEXT TO_CHAR(...) -> timestamptz]
);

-- ---------------------------------------------------------------------------
-- sample_images — bytea store for photo intake. Source: [both 20260625].
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sample_images (
  id           TEXT PRIMARY KEY,                  -- [both] caller-supplied id or UUID
  content_type TEXT NOT NULL,                     -- [both] MIME type
  bytes        BYTEA NOT NULL,                    -- [both] image binary
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now() -- [both]
);

-- ---------------------------------------------------------------------------
-- roles / users — [new] RBAC, previously hardcoded in data-pimp static/os.js.
-- Seeds mirror apps/shell/core/roles.json (CONTRACTS "Roles config").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roles (
  name         TEXT PRIMARY KEY,                  -- [new] admin|creator|warehouse
  flags        JSONB NOT NULL,                    -- [new] feature flags map
  default_home JSONB NOT NULL DEFAULT '[]'        -- [new] [appPath, side][] boot layout
);

CREATE TABLE IF NOT EXISTS public.users (
  id           SERIAL PRIMARY KEY,                -- [new]
  username     TEXT UNIQUE NOT NULL,              -- [new] shell user id (dj, ka, @handle)
  display_name TEXT,                              -- [new]
  role         TEXT NOT NULL REFERENCES public.roles(name),  -- [new]
  created_at   TIMESTAMPTZ DEFAULT now()          -- [new]
);

-- ---------------------------------------------------------------------------
-- graylog_messages — [new] Postgres port of tok-scrape graylog-shim's Deno KV
-- store (CONTRACTS "Graylog store"). SQL against this table is owned by
-- @lp-os/graylog; it lives here so one migration builds the whole database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.graylog_messages (
  id          BIGSERIAL PRIMARY KEY,              -- [new]
  message_id  TEXT UNIQUE NOT NULL,               -- [new] original _id or generated UUID
  "timestamp" TIMESTAMPTZ NOT NULL,               -- [new] message time
  source      TEXT NOT NULL,                      -- [new] GELF host/source
  message     TEXT NOT NULL DEFAULT '',           -- [new] short_message
  fields      JSONB NOT NULL DEFAULT '{}'         -- [new] flat field map returned verbatim by search
);

-- ---------------------------------------------------------------------------
-- Indexes (CONTRACTS "Database" + "Graylog store").
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_samples_qr_code ON public.samples (qr_code);
CREATE INDEX IF NOT EXISTS idx_samples_bundle_id ON public.samples (bundle_id);
CREATE INDEX IF NOT EXISTS idx_samples_status ON public.samples (status);
CREATE INDEX IF NOT EXISTS idx_samples_sold_to ON public.samples (sold_to);
CREATE INDEX IF NOT EXISTS idx_samples_related_upc ON public.samples USING GIN (related_upc);
CREATE INDEX IF NOT EXISTS idx_bundles_qr_code ON public.bundles (qr_code);
CREATE INDEX IF NOT EXISTS idx_transactions_sample_id ON public.transactions (sample_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions (created_at);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_timestamp ON public.graylog_messages ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_source_timestamp ON public.graylog_messages (source, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_creator ON public.graylog_messages ((fields->>'creator'), "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_fields ON public.graylog_messages USING GIN (fields);

-- ---------------------------------------------------------------------------
-- Seeds (CONTRACTS "Roles config"). Warehouse default_home carries the
-- ?status=cleared_to_sell query inside the appPath entry by design.
-- ---------------------------------------------------------------------------
INSERT INTO public.roles (name, flags, default_home) VALUES
  ('admin', '{"*": true}'::jsonb, '[]'::jsonb),
  ('creator', '{"folder.member": true}'::jsonb,
    '[["Member/App","left"],["Member/Web","right"]]'::jsonb),
  ('warehouse',
    '{"folder.apps": true, "app.inventory": true, "app.kiosk": true, "app.installExtension": true, "app.scanner": true, "app.graylog": false, "app.productAnalysis": false, "folder.demos": false, "folder.member": false, "ops.debugCounts": false, "ops.checkoutAlerts": true}'::jsonb,
    '[["Apps/Inventory?status=cleared_to_sell","left"],["Apps/Kiosk","right"]]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.users (username, display_name, role) VALUES
  ('dj', 'DJ', 'admin'),
  ('ka', 'Karl', 'warehouse'),
  ('@boosteddealsdaily', '@boosteddealsdaily', 'creator')
ON CONFLICT (username) DO NOTHING;
