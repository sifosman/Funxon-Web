-- Add a unique constraint on vendors.user_id so the payfast-checkout edge
-- function's upsert(..., { onConflict: 'user_id' }) can match an existing row.
-- venues already had venues_user_id_key; vendors only had a plain FK on user_id,
-- so PostgREST rejected the ON CONFLICT clause and vendor checkout returned
-- "Could not prepare payment" (500) — surfaced to users as "edge function
-- returned a non-2xx status code".
ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_user_id_key UNIQUE (user_id);
