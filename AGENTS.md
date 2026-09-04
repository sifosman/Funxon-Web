# Funxon App — Project Notes
<!-- last-updated: 2025-09-04 -->

## Build / Verify Commands
- `npx tsc --noEmit` — typecheck (note: `tests/playwright/bugfix-verification.spec.ts` has 1 pre-existing TS error, unrelated to app code)
- `npm run build` — web build (`expo export --platform web`) → `dist/`, deployed to Vercel (funxon.co.za, SPA rewrites in vercel.json)
- `npm run typecheck` — same as tsc --noEmit

## PayFast Integration (updated 2026-09-04)

### Architecture (server-side signing)
- `supabase/functions/payfast-checkout` — the ONLY place that signs payments. Verifies the caller's JWT, resolves the price server-side (vendors: `subscription_tiers` table; venues: hardcoded `VENUE_PLAN_PRICES` map that must match `src/screens/VenueListingPlansScreen.tsx`), upserts the vendor/venue row with `pending_payment_id`, returns a signed checkout URL. `verify_jwt: true`.
- `supabase/functions/payfast-itn` — PayFast ITN webhook. Verifies signature + amount, idempotent per `pf_payment_id`, activates subscription on COMPLETE, creates `subscription_invoices` rows for vendors. `verify_jwt: false` (PayFast can't send a Supabase JWT).
- `supabase/functions/payfast-redirect` — 302s to `funxon://payment/success|cancel` deep links for native.
- Client calls the edge function via `src/lib/payfastCheckout.ts` (`createPayFastCheckout`, `pollSubscriptionActivated`). Merchant credentials are NEVER in the app bundle.
- Payment result UX: `src/screens/PaymentResultScreen.tsx` (success/pending/failed/cancelled), registered in ProfileNavigator as `PaymentResult`, deep-linked via `payment/:status` in `src/navigation/linking.ts`.

### PayFast secrets (Supabase Dashboard > Edge Functions > Secrets)
- `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SANDBOX` ('true' = sandbox, 'false' = live)
- With no secrets set + sandbox default, functions fall back to PayFast's public test merchant 10000100 / passphrase jt7NOE43FZPn.
- In live mode the passphrase secret is REQUIRED (ITN returns 500 without it).

### Venue plan prices are duplicated in two places (keep in sync):
- `supabase/functions/payfast-checkout/index.ts` (VENUE_PLAN_PRICES)
- `supabase/functions/payfast-itn/index.ts` (VENUE_PLAN_PRICES)
- Source of truth for display: `src/screens/VenueListingPlansScreen.tsx` (monthly R1750, 6_month R9750, 12_month R18000)
- Vendor prices come from the `subscription_tiers` table (premium R299/mo R3289/yr, premium_plus R399/mo R4389/yr).

### Known quirks
- Vendor 6_month/12_month billing values exist in the type but vendor plans only use monthly/yearly; venue plans use monthly/6_month/12_month (once-off payments, no subscription_type sent).
- ITN renewal expiry is calculated from "now", not from the current expiry date (early renewals lose remaining days).
