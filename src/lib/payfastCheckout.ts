// Server-side PayFast checkout creation.
// The payfast-checkout edge function authenticates the user, resolves the
// plan price server-side, and returns a fully-signed PayFast checkout URL.
// Merchant credentials never live in the app bundle.

import { supabase } from './supabaseClient';

export type PayFastCheckoutRequest = {
  productType: 'vendor' | 'venue';
  planKey: string;
  billing: 'monthly' | 'yearly' | '6_month' | '12_month';
  buyer?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  itemName?: string;
  // Web builds must redirect back to an https URL on this origin; native uses
  // the payfast-redirect edge function which 302s to the funxon:// deep link.
  webOrigin?: string;
};

export type PayFastCheckoutSession = {
  checkoutUrl: string;
  mPaymentId: string;
  amount: string;
  planKey: string;
  billing: string;
  productType: 'vendor' | 'venue';
  sandbox?: boolean;
};

export async function createPayFastCheckout(
  request: PayFastCheckoutRequest,
): Promise<PayFastCheckoutSession> {
  const { data, error } = await supabase.functions.invoke('payfast-checkout', {
    body: request,
  });

  if (error || !data?.checkoutUrl) {
    const message =
      (data as any)?.error ||
      error?.message ||
      'Could not start the PayFast checkout. Please try again.';
    throw new Error(message);
  }

  return data as PayFastCheckoutSession;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the vendor/venue subscription status until the ITN activates it.
 * Returns true once the subscription is active, false if it does not
 * activate within `timeoutMs`.
 */
export async function pollSubscriptionActivated(
  productType: 'vendor' | 'venue',
  userId: string,
  timeoutMs = 20000,
): Promise<boolean> {
  const table = productType === 'venue' ? 'venues' : 'vendors';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data } = await supabase
      .from(table)
      .select('subscription_status')
      .eq('user_id', userId)
      .maybeSingle();
    if ((data as any)?.subscription_status === 'active') return true;
    await sleep(2500);
  }
  return false;
}
