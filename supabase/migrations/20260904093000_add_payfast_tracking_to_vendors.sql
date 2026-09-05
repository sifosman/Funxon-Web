-- Add PayFast tracking columns to vendors.
-- The payfast-checkout edge function upserts pending_payment_id and the
-- payfast-itn webhook matches on pending_payment_id / writes payfast_payment_id.
-- These columns existed on `venues` but were missing on `vendors`, breaking the
-- vendor PayFast checkout/activation flow (400 -> "Could not prepare payment").
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS pending_payment_id text,
  ADD COLUMN IF NOT EXISTS payfast_payment_id text;

CREATE INDEX IF NOT EXISTS vendors_pending_payment_id_idx ON public.vendors (pending_payment_id);
CREATE INDEX IF NOT EXISTS vendors_payfast_payment_id_idx ON public.vendors (payfast_payment_id);
