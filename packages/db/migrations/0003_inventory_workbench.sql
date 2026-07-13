-- 0003_inventory_workbench.sql — Inventory Workbench bulk-edit support.
--
-- samples gains optimistic-concurrency columns (version / updated_at) kept
-- fresh by a BEFORE UPDATE trigger, so EVERY writer — including the external
-- tracker PATCHing through /api/samples/:id — bumps them without code changes.
-- transactions gains batch attribution plus a before/after audit payload.
-- inventory_batches stores one row per bulk request; request_id is the
-- idempotency anchor: a replayed requestId returns the stored result instead
-- of reapplying the mutations (see packages/db/inventory.ts).

ALTER TABLE public.samples
  ADD COLUMN IF NOT EXISTS version    INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.samples_touch_version() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    NEW.version    := COALESCE(OLD.version, 1) + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_samples_touch_version ON public.samples;
CREATE TRIGGER trg_samples_touch_version
  BEFORE UPDATE ON public.samples
  FOR EACH ROW EXECUTE FUNCTION public.samples_touch_version();

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS batch_id   UUID,
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS changes    JSONB;

CREATE TABLE IF NOT EXISTS public.inventory_batches (
  batch_id       UUID PRIMARY KEY,
  request_id     UUID UNIQUE NOT NULL,
  operator       TEXT NOT NULL,
  mutation_count INTEGER NOT NULL,
  result         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_batch_id ON public.transactions (batch_id);
