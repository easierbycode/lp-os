// schema.ts — embedded copy of migrations/*.sql used by ensureSchema()
// (embedded so ensureSchema needs no file-read permission at runtime). Every
// statement is idempotent. KEEP IN SYNC with the migrations —
// test/schema_sync_test.ts asserts table/index/seed coverage matches the
// union of every file in migrations/.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.bundles (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT,
  qr_code    TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.samples (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  brand                 TEXT,
  location              TEXT,
  qr_code               TEXT,
  picture_url           TEXT,
  tiktok_affiliate_link TEXT,
  fire_sale             TEXT,
  status                TEXT NOT NULL DEFAULT 'available',
  current_price         DOUBLE PRECISION,
  best_price            DOUBLE PRECISION,
  best_price_source     TEXT,
  last_price_checked_at TIMESTAMPTZ,
  bundle_id             INTEGER REFERENCES public.bundles(id) ON DELETE SET NULL,
  checked_out_at        TIMESTAMPTZ,
  checked_in_at         TIMESTAMPTZ,
  checked_out_to        TEXT,
  sold_at               TIMESTAMPTZ,
  sold_to               TEXT,
  sold_price            DOUBLE PRECISION,
  notes                 TEXT,
  c19                   TEXT,
  related_upc           TEXT[],
  product_json          JSONB,
  quantity              INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id             SERIAL PRIMARY KEY,
  action         TEXT NOT NULL,
  sample_id      INTEGER REFERENCES public.samples(id) ON DELETE SET NULL,
  bundle_id      INTEGER REFERENCES public.bundles(id) ON DELETE SET NULL,
  scanned_code   TEXT,
  operator       TEXT,
  checked_out_to TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sample_images (
  id           TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.roles (
  name         TEXT PRIMARY KEY,
  flags        JSONB NOT NULL,
  default_home JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS public.users (
  id           SERIAL PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role         TEXT NOT NULL REFERENCES public.roles(name),
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.listings (
  id          SERIAL PRIMARY KEY,
  sample_id   INTEGER REFERENCES public.samples(id) ON DELETE SET NULL,
  marketplace TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  source      TEXT,
  sku         TEXT,
  offer_id    TEXT,
  external_id TEXT,
  listing_url TEXT,
  ask_price   DOUBLE PRECISION,
  currency    TEXT DEFAULT 'USD',
  creator     TEXT,
  operator    TEXT,
  error       TEXT,
  listed_at   TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketplace_accounts (
  marketplace  TEXT PRIMARY KEY,
  environment  TEXT NOT NULL DEFAULT 'sandbox',
  credentials  JSONB NOT NULL DEFAULT '{}',
  settings     JSONB NOT NULL DEFAULT '{}',
  connected_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

CREATE TABLE IF NOT EXISTS public.graylog_messages (
  id          BIGSERIAL PRIMARY KEY,
  message_id  TEXT UNIQUE NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  source      TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  fields      JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_samples_qr_code ON public.samples (qr_code);
CREATE INDEX IF NOT EXISTS idx_samples_bundle_id ON public.samples (bundle_id);
CREATE INDEX IF NOT EXISTS idx_samples_status ON public.samples (status);
CREATE INDEX IF NOT EXISTS idx_samples_sold_to ON public.samples (sold_to);
CREATE INDEX IF NOT EXISTS idx_samples_related_upc ON public.samples USING GIN (related_upc);
CREATE INDEX IF NOT EXISTS idx_bundles_qr_code ON public.bundles (qr_code);
CREATE INDEX IF NOT EXISTS idx_transactions_sample_id ON public.transactions (sample_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions (created_at);
CREATE INDEX IF NOT EXISTS idx_listings_sample_id ON public.listings (sample_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON public.listings (status);
CREATE INDEX IF NOT EXISTS idx_listings_marketplace_status ON public.listings (marketplace, status);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_timestamp ON public.graylog_messages ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_source_timestamp ON public.graylog_messages (source, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_creator ON public.graylog_messages ((fields->>'creator'), "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_graylog_messages_fields ON public.graylog_messages USING GIN (fields);

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
`;
