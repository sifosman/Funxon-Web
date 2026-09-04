// PayFast Instant Transaction Notification (ITN) handler.
// PayFast POSTs server-to-server payment notifications here.
// - Verifies the request signature (passphrase from secrets; sandbox test
//   passphrase only when PAYFAST_SANDBOX=true)
// - Verifies the paid amount matches the plan price resolved server-side
// - Activates the matching vendor/venue subscription on COMPLETE
// - Creates a subscription invoice for vendors
// - Idempotent: duplicate ITNs for the same pf_payment_id are ignored

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SANDBOX_PASSPHRASE = 'jt7NOE43FZPn';

// Must match VENUE_PLAN_PRICES in payfast-checkout/index.ts and the prices
// shown in VenueListingPlansScreen.tsx
const VENUE_PLAN_PRICES: Record<string, number> = {
  monthly: 1750,
  '6_month': 9750,
  '12_month': 18000,
};

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function calculateExpiryDate(startDate: Date, billingPeriod: string): Date {
  const expiry = new Date(startDate);
  switch (billingPeriod) {
    case '6_month':
      expiry.setMonth(expiry.getMonth() + 6);
      break;
    case '12_month':
    case 'yearly':
      expiry.setFullYear(expiry.getFullYear() + 1);
      break;
    default: // 'monthly' and anything else
      expiry.setMonth(expiry.getMonth() + 1);
  }
  return expiry;
}

async function md5Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('MD5', data);
  return toHex(hash);
}

function buildSignaturePayload(params: Record<string, string>, passphrase?: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'signature')
    .sort();

  const parts: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  let payload = parts.join('&');
  if (passphrase) {
    payload += `&passphrase=${encodeURIComponent(passphrase)}`;
  }
  return payload;
}

function parseFormUrlEncoded(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(body);
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  // PayFast ITN will POST x-www-form-urlencoded
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();
  const params = parseFormUrlEncoded(rawBody);

  // Basic required fields
  const paymentStatus = params.payment_status;
  const mPaymentId = params.m_payment_id;
  const signature = params.signature;

  if (!paymentStatus || !mPaymentId || !signature) {
    return new Response('Bad Request', { status: 400 });
  }

  // Verify signature (PayFast). In live mode the passphrase secret is required —
  // never fall back to the sandbox test passphrase.
  const isSandbox = (Deno.env.get('PAYFAST_SANDBOX') ?? 'true') === 'true';
  const envPassphrase = Deno.env.get('PAYFAST_PASSPHRASE') ?? '';
  const passphrase = envPassphrase || (isSandbox ? SANDBOX_PASSPHRASE : '');
  if (!passphrase) {
    console.error('PayFast ITN: PAYFAST_PASSPHRASE secret is not set (live mode)');
    return new Response('Server misconfigured', { status: 500 });
  }

  const expectedPayload = buildSignaturePayload(params, passphrase);
  const expectedSig = await md5Hex(expectedPayload);

  if (expectedSig !== signature) {
    console.error('PayFast ITN signature mismatch', { m_payment_id: mPaymentId });
    return new Response('Invalid signature', { status: 400 });
  }

  // Service role client for DB updates
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return new Response('Server misconfigured', { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const pfPaymentId = params.pf_payment_id ?? null;
  const paidAmount = parseFloat(params.amount ?? '0');

  // Non-complete statuses (CANCELLED / FAILED / PENDING): log and leave the
  // subscription untouched (it stays inactive until a successful payment).
  if (paymentStatus !== 'COMPLETE') {
    console.warn(`PayFast ITN: payment ${mPaymentId} status=${paymentStatus} amount=${params.amount} — no activation`);
    return new Response('OK', { status: 200 });
  }

  const nowIso = new Date().toISOString();

  // Venue activation: match on pending_payment_id
  const { data: venueRow, error: venueErr } = await supabase
    .from('venues')
    .select('id, subscription_plan_key, features, billing_period, subscription_status, payfast_payment_id')
    .eq('pending_payment_id', mPaymentId)
    .maybeSingle();

  if (venueErr) {
    console.error('Failed to lookup venue by pending_payment_id', venueErr);
  }

  if (venueRow?.id) {
    // Idempotency: skip if this PayFast payment was already processed
    if (pfPaymentId && venueRow.payfast_payment_id === pfPaymentId) {
      console.log(`Venue ${venueRow.id} already processed for pf_payment_id ${pfPaymentId}`);
      return new Response('OK', { status: 200 });
    }

    // Amount verification against the server-side plan price
    const expectedVenueAmount = VENUE_PLAN_PRICES[venueRow.subscription_plan_key ?? ''];
    if (expectedVenueAmount != null && Math.abs(paidAmount - expectedVenueAmount) > 0.01) {
      console.error(
        `PayFast ITN amount mismatch for venue ${venueRow.id}: expected R${expectedVenueAmount.toFixed(2)}, got R${paidAmount.toFixed(2)} (${mPaymentId}) — not activating`,
      );
      return new Response('OK', { status: 200 });
    }

    const isPaidVenuePlan = venueRow.subscription_plan_key !== 'get_started';
    const updatedFeatures = isPaidVenuePlan
      ? { ...(venueRow.features ?? {}), featured: true, featured_listings: true }
      : (venueRow.features ?? {});

    const now = new Date();
    const venueExpiresAt = calculateExpiryDate(now, venueRow.billing_period || 'monthly');

    const { error: updErr } = await supabase
      .from('venues')
      .update({
        subscription_status: 'active',
        subscription_started_at: nowIso,
        subscription_expires_at: venueExpiresAt.toISOString(),
        next_payment_due: venueExpiresAt.toISOString(),
        last_payment_at: nowIso,
        payfast_payment_id: pfPaymentId,
        features: updatedFeatures,
      })
      .eq('id', venueRow.id);

    if (updErr) {
      console.error('Failed to activate venue subscription', updErr);
    } else {
      console.log(`Venue ${venueRow.id} activated. Expires: ${venueExpiresAt.toISOString()}`);
    }
  }

  // Vendor activation: match on pending_payment_id
  const { data: vendorRow, error: vendorErr } = await supabase
    .from('vendors')
    .select('id, subscription_tier, billing_period, billing_name, billing_email, subscription_status, payfast_payment_id')
    .eq('pending_payment_id', mPaymentId)
    .maybeSingle();

  if (vendorErr) {
    console.error('Failed to lookup vendor by pending_payment_id', vendorErr);
  }

  if (vendorRow?.id) {
    // Idempotency: skip if this PayFast payment was already processed
    if (pfPaymentId && vendorRow.payfast_payment_id === pfPaymentId) {
      console.log(`Vendor ${vendorRow.id} already processed for pf_payment_id ${pfPaymentId}`);
      return new Response('OK', { status: 200 });
    }

    // Amount verification against the tier price for the billed period
    let expectedVendorAmount: number | null = null;
    const { data: tier } = await supabase
      .from('subscription_tiers')
      .select('price_monthly, price_yearly')
      .eq('tier_name', vendorRow.subscription_tier ?? 'get_started')
      .maybeSingle();
    if (tier) {
      expectedVendorAmount = Number(
        vendorRow.billing_period === 'yearly' ? tier.price_yearly : tier.price_monthly,
      );
    }
    if (expectedVendorAmount != null && !isNaN(expectedVendorAmount) && Math.abs(paidAmount - expectedVendorAmount) > 0.01) {
      console.error(
        `PayFast ITN amount mismatch for vendor ${vendorRow.id}: expected R${expectedVendorAmount.toFixed(2)}, got R${paidAmount.toFixed(2)} (${mPaymentId}) — not activating`,
      );
      return new Response('OK', { status: 200 });
    }

    const isPaidVendorTier = vendorRow.subscription_tier !== 'get_started';

    const now = new Date();
    const vendorExpiresAt = calculateExpiryDate(now, vendorRow.billing_period || 'monthly');

    const { error: updErr } = await supabase
      .from('vendors')
      .update({
        subscription_status: 'active',
        subscription_started_at: nowIso,
        subscription_expires_at: vendorExpiresAt.toISOString(),
        next_payment_due: vendorExpiresAt.toISOString(),
        last_payment_at: nowIso,
        payfast_payment_id: pfPaymentId,
        featured_listing: isPaidVendorTier,
        reminder_5day_sent: false,
        reminder_1day_sent: false,
      })
      .eq('id', vendorRow.id);

    if (updErr) {
      console.error('Failed to activate vendor subscription', updErr);
    } else {
      console.log(`Vendor ${vendorRow.id} activated. Expires: ${vendorExpiresAt.toISOString()}`);

      // Create the subscription invoice (skip if one exists for this payment)
      if (pfPaymentId) {
        const { data: existingInvoice } = await supabase
          .from('subscription_invoices')
          .select('id')
          .eq('payfast_payment_id', pfPaymentId)
          .maybeSingle();

        if (!existingInvoice) {
          const invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
          const { error: invErr } = await supabase.from('subscription_invoices').insert({
            vendor_id: vendorRow.id,
            invoice_number: invoiceNumber,
            amount: isNaN(paidAmount) ? 0 : paidAmount,
            currency: 'ZAR',
            tier_name: vendorRow.subscription_tier ?? 'get_started',
            billing_period: vendorRow.billing_period || 'monthly',
            status: 'paid',
            payment_method: 'payfast',
            payfast_payment_id: pfPaymentId,
            payment_date: nowIso,
            period_start: nowIso,
            period_end: vendorExpiresAt.toISOString(),
            billing_name: vendorRow.billing_name ?? null,
            billing_email: vendorRow.billing_email ?? null,
          });
          if (invErr) {
            console.error('Failed to create subscription invoice', invErr);
          } else {
            console.log(`Invoice ${invoiceNumber} created for vendor ${vendorRow.id}`);
          }
        }
      }
    }
  }

  if (!venueRow?.id && !vendorRow?.id) {
    console.warn('No venue/vendor matched pending_payment_id', { m_payment_id: mPaymentId });
  }

  return new Response('OK', { status: 200 });
});
