-- 0002_marketplace.sql — marketplace listings (eBay first of the initial three
-- marketplaces) plus per-install marketplace accounts (API credentials +
-- settings entered through the shell's Marketplace window).
--
-- listings is the Postgres truth for "what is (or was) live where":
--   status: pending → listed → ended|sold, or pending → failed.
--   source: manual | schedule | status-auto (what triggered the listing).
--   external_id/offer_id/sku are the marketplace-side identifiers (for eBay:
--   listingId / offerId / the inventory-item SKU).
-- The Graylog "listed"/"listing_failed" events remain the analytics history;
-- this table is what UIs join against samples for current listing status.
--
-- marketplace_accounts is single-tenant per marketplace (one eBay account per
-- LP-OS install — login is mocked, so there is no per-user credential store):
--   credentials jsonb: for eBay {clientId, clientSecret, refreshToken,
--   accessToken?} — never returned whole by the API surface, never logged.
--   settings jsonb: auto-list toggles, ship-from location, listing defaults.

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

CREATE INDEX IF NOT EXISTS idx_listings_sample_id ON public.listings (sample_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON public.listings (status);
CREATE INDEX IF NOT EXISTS idx_listings_marketplace_status ON public.listings (marketplace, status);
