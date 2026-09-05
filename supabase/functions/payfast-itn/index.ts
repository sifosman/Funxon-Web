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

// Deno's WebCrypto does not implement the legacy MD5 algorithm —
// crypto.subtle.digest('MD5', ...) throws "NotSupportedError: Unrecognized
// algorithm name". PayFast signatures are MD5 hashes, so we compute them with
// this pure-JS RFC 1321 implementation (verified against known test vectors).
function md5Digest(inputBytes: Uint8Array): Uint8Array {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }
  const len = inputBytes.length;
  const totalLen = (((len + 8) >> 6) + 1) << 6; // multiple of 64, >= len + 9
  const msg = new Uint8Array(totalLen);
  msg.set(inputBytes);
  msg[len] = 0x80;
  const bitLenHi = Math.floor((len * 8) / 4294967296);
  const bitLenLo = (len * 8) % 4294967296;
  let w = totalLen - 8;
  msg[w++] = bitLenLo & 0xff; msg[w++] = (bitLenLo >>> 8) & 0xff;
  msg[w++] = (bitLenLo >>> 16) & 0xff; msg[w++] = (bitLenLo >>> 24) & 0xff;
  msg[w++] = bitLenHi & 0xff; msg[w++] = (bitLenHi >>> 8) & 0xff;
  msg[w++] = (bitLenHi >>> 16) & 0xff; msg[w++] = (bitLenHi >>> 24) & 0xff;

  let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
  const M = new Int32Array(16);
  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24)) | 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      const s = S[i];
      const shifted = ((F << s) | (F >>> (32 - s))) | 0;
      A = D; D = C; C = B;
      B = (B + shifted) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

function md5Hex(input: string): string {
  const digest = md5Digest(new TextEncoder().encode(input));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// PHP-style urlencoding: spaces become '+', and ~ ! ' ( ) * are percent-encoded.
// This matches exactly how PayFast builds and validates signatures server-side,
// so values containing spaces/punctuation (e.g. item_name) verify correctly.
function pfUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/~/g, '%7E')
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildSignaturePayload(params: Record<string, string>, passphrase?: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'signature')
    .sort();

  const parts: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === '') continue;
    parts.push(`${pfUrlEncode(key)}=${pfUrlEncode(value)}`);
  }

  let payload = parts.join('&');
  if (passphrase) {
    payload += `&passphrase=${pfUrlEncode(passphrase)}`;
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
  const expectedSig = md5Hex(expectedPayload);

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
