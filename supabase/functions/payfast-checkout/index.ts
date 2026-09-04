// PayFast Checkout Edge Function
// Creates a server-signed PayFast payment for an authenticated user.
// - Verifies the caller's JWT (never trusts client-sent prices)
// - Resolves the amount server-side from the DB (vendor) / plan map (venue)
// - Pre-records the vendor/venue row as inactive with pending_payment_id
// - Returns a fully-signed PayFast checkout URL
//
// Required secrets (Supabase dashboard > Edge Functions > Secrets):
//   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE
//   PAYFAST_SANDBOX ('true' while testing, 'false' for live)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SANDBOX_MERCHANT_ID = '10000100';
const SANDBOX_MERCHANT_KEY = '46f0cd694581a';
const SANDBOX_PASSPHRASE = 'jt7NOE43FZPn';

// Must match the prices shown in VenueListingPlansScreen.tsx
const VENUE_PLAN_PRICES: Record<string, number> = {
  monthly: 1750,
  '6_month': 9750,
  '12_month': 18000,
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function md5Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('MD5', data);
  return toHex(hash);
}

// PayFast request signatures use the field order of the PayFast payment form
// (NOT alphabetical), with the passphrase appended before hashing.
function generateRequestSignature(data: Record<string, string>, passphrase: string): Promise<string> {
  const orderedKeys = [
    'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
    'name_first', 'name_last', 'email_address', 'cell_number',
    'm_payment_id', 'amount', 'item_name', 'item_description',
    'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
    'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
    'email_confirmation', 'confirmation_address', 'payment_method',
    'subscription_type', 'billing_date', 'recurring_amount', 'frequency', 'cycles',
  ];

  const parts: string[] = [];
  for (const key of orderedKeys) {
    const value = data[key];
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  let payload = parts.join('&');
  if (passphrase) {
    payload += `&passphrase=${encodeURIComponent(passphrase)}`;
  }
  return md5Hex(payload);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('payfast-checkout: missing Supabase env config');
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Authenticate the caller
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Not authenticated' }, 401);
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) {
    return json({ error: 'Not authenticated' }, 401);
  }

  const body = await req.json().catch(() => null);
  const productType = body?.productType === 'venue' ? 'venue' : 'vendor';
  const planKey = typeof body?.planKey === 'string' ? body.planKey.trim() : '';
  const billing = typeof body?.billing === 'string' ? body.billing.trim() : 'monthly';
  const buyer = body?.buyer ?? {};
  const webOrigin = typeof body?.webOrigin === 'string' && body.webOrigin.startsWith('https://')
    ? body.webOrigin.replace(/\/$/, '')
    : '';

  if (!planKey || planKey === 'get_started') {
    return json({ error: 'Invalid plan' }, 400);
  }

  // Resolve the amount server-side — never trust a client-sent price
  let amount: number;
  let billingPeriod: string;
  const admin = createClient(supabaseUrl, serviceRoleKey);
  if (productType === 'venue') {
    billingPeriod = billing;
    amount = VENUE_PLAN_PRICES[planKey] ?? VENUE_PLAN_PRICES[billing] ?? 0;
    if (!amount) {
      return json({ error: 'Unknown venue plan' }, 400);
    }
  } else {
    const { data: tier, error: tierErr } = await admin
      .from('subscription_tiers')
      .select('price_monthly, price_yearly, is_active')
      .eq('tier_name', planKey)
      .maybeSingle();
    if (tierErr || !tier || tier.is_active === false) {
      return json({ error: 'Unknown plan' }, 400);
    }
    billingPeriod = billing === 'yearly' ? 'yearly' : 'monthly';
    amount = Number(billingPeriod === 'yearly' ? tier.price_yearly : tier.price_monthly) || 0;
    if (!amount) {
      return json({ error: 'Plan price not configured' }, 400);
    }
  }

  // PayFast credentials
  const isSandbox = (Deno.env.get('PAYFAST_SANDBOX') ?? 'true') === 'true';
  const envMerchantId = Deno.env.get('PAYFAST_MERCHANT_ID') ?? '';
  const envMerchantKey = Deno.env.get('PAYFAST_MERCHANT_KEY') ?? '';
  const envPassphrase = Deno.env.get('PAYFAST_PASSPHRASE') ?? '';

  const merchantId = envMerchantId || (isSandbox ? SANDBOX_MERCHANT_ID : '');
  const merchantKey = envMerchantKey || (isSandbox ? SANDBOX_MERCHANT_KEY : '');
  const passphrase = envPassphrase || (isSandbox ? SANDBOX_PASSPHRASE : '');

  if (!merchantId || !merchantKey || (!passphrase && !isSandbox)) {
    console.error('payfast-checkout: PayFast credentials missing for live mode', {
      hasMerchantId: !!merchantId,
      hasMerchantKey: !!merchantKey,
      hasPassphrase: !!passphrase,
    });
    return json({ error: 'Payment gateway not configured' }, 500);
  }

  const baseUrl = isSandbox
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';

  const mPaymentId = `pf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Pre-record the subscription as inactive so the ITN can match it.
  // If the subscription is already active (renewal/upgrade), keep it active
  // so the user is never downgraded while paying.
  const buyerEmail = typeof buyer.email === 'string' ? buyer.email.trim() : '';
  const buyerName = [buyer.firstName, buyer.lastName].filter(Boolean).join(' ').trim();
  const buyerPhone = typeof buyer.phone === 'string' ? buyer.phone.trim() : '';

  if (productType === 'venue') {
    const { data: existing } = await admin
      .from('venues')
      .select('id, subscription_status')
      .eq('user_id', user.id)
      .maybeSingle();
    const { error: upsertErr } = await admin
      .from('venues')
      .upsert(
        {
          user_id: user.id,
          subscription_plan_key: planKey,
          subscription_status: existing?.subscription_status === 'active' ? 'active' : 'inactive',
          billing_period: planKey,
          pending_payment_id: mPaymentId,
          billing_email: buyerEmail || undefined,
          billing_name: buyerName || undefined,
          billing_phone: buyerPhone || undefined,
        },
        { onConflict: 'user_id' },
      );
    if (upsertErr) {
      console.error('payfast-checkout: failed to upsert venue pending record', upsertErr);
      return json({ error: 'Could not prepare payment' }, 500);
    }
  } else {
    const { data: existing } = await admin
      .from('vendors')
      .select('id, subscription_status')
      .eq('user_id', user.id)
      .maybeSingle();
    const { error: upsertErr } = await admin
      .from('vendors')
      .upsert(
        {
          user_id: user.id,
          subscription_tier: planKey,
          subscription_status: existing?.subscription_status === 'active' ? 'active' : 'inactive',
          billing_period: billingPeriod,
          pending_payment_id: mPaymentId,
          email: buyerEmail || undefined,
          billing_email: buyerEmail || undefined,
          billing_name: buyerName || undefined,
          billing_phone: buyerPhone || undefined,
        },
        { onConflict: 'user_id' },
      );
    if (upsertErr) {
      console.error('payfast-checkout: failed to upsert vendor pending record', upsertErr);
      return json({ error: 'Could not prepare payment' }, 500);
    }
  }

  // Build the signed PayFast payment data
  const returnUrl = webOrigin ? `${webOrigin}/payment/success` : `${supabaseUrl}/functions/v1/payfast-redirect?type=success`;
  const cancelUrl = webOrigin
    ? `${webOrigin}/payment/cancel`
    : `${supabaseUrl}/functions/v1/payfast-redirect?type=cancel`;
  const notifyUrl = `${supabaseUrl}/functions/v1/payfast-itn`;

  const isOnceOff = billing === '6_month' || billing === '12_month';
  const itemName = typeof body?.itemName === 'string' && body.itemName.trim()
    ? body.itemName.trim()
    : `Funxon ${productType === 'venue' ? 'Venue' : ''} ${planKey.replace(/_/g, ' ')} Plan (${billing})`.replace(/\s+/g, ' ').trim();

  const data: Record<string, string> = {
    merchant_id: merchantId,
    merchant_key: merchantKey,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: notifyUrl,
    m_payment_id: mPaymentId,
    amount: amount.toFixed(2),
    item_name: itemName,
    item_description: `${productType === 'venue' ? 'Venue' : 'Vendor'} subscription - billed ${billing}`,
  };
  if (buyer.firstName) data.name_first = String(buyer.firstName).trim();
  if (buyer.lastName) data.name_last = String(buyer.lastName).trim();
  if (buyerEmail) data.email_address = buyerEmail;
  if (buyerPhone) data.cell_number = buyerPhone;

  if (!isOnceOff) {
    data.subscription_type = '1';
    data.frequency = billingPeriod === 'yearly' ? '6' : '3';
    data.recurring_amount = amount.toFixed(2);
    data.cycles = '0';
  }

  data.signature = await generateRequestSignature(data, passphrase);

  const queryString = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  console.log(`payfast-checkout: created ${isSandbox ? 'sandbox' : 'live'} payment ${mPaymentId} for user ${user.id} (${productType} ${planKey} ${billing}, R${amount.toFixed(2)})`);

  return json({
    checkoutUrl: `${baseUrl}?${queryString}`,
    mPaymentId,
    amount: amount.toFixed(2),
    planKey,
    billing,
    productType,
    sandbox: isSandbox,
  });
});
