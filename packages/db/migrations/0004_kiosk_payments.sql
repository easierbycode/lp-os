-- 0004_kiosk_payments.sql — self-serve kiosk checkout (/kiosk/self).
--
-- One row per kiosk checkout ("quote"). Creating a quote locks in the total
-- from samples.current_price and moves each sample to status 'reserved' so it
-- cannot be sold twice; items keeps each sample's prior status so a cancelled
-- or expired quote restores it exactly (packages/db/kiosk-payments.ts).
--
-- method:
--   cashapp_link  plain https://cash.app/$cashtag/<amount> link (QR / NFC).
--                 Nothing confirms it automatically: the customer taps
--                 "I've paid" (status claimed) and staff confirm or reject.
--   square        Square Web Payments SDK Cash App Pay: the token is charged
--                 server-side and the quote is marked paid automatically.
--
-- status: pending | charging | claimed | paid | cancelled | expired |
--         rejected | error

CREATE TABLE IF NOT EXISTS public.kiosk_payments (
  id                  UUID PRIMARY KEY,
  kiosk_id            TEXT,
  method              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  items               JSONB NOT NULL,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  pay_url             TEXT,
  idempotency_key     TEXT UNIQUE,
  attempts            INTEGER NOT NULL DEFAULT 0,
  provider_payment_id TEXT,
  receipt_url         TEXT,
  receipt_number      TEXT,
  confirmed_by        TEXT,
  last_error          TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  claimed_at          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kiosk_payments_status_expires ON public.kiosk_payments (status, expires_at);
