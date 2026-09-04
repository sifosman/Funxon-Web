// Centralized environment variable access with safe fallbacks.
// Expo automatically injects EXPO_PUBLIC_* into process.env.
// We also read from Constants for EAS builds.

import Constants from 'expo-constants';

function getEnv(key: string, fallback: string): string {
  // Try process.env first (works in dev and EAS builds with EXPO_PUBLIC_ prefix)
  const val = process.env[key];
  if (val) return val;

  // Fallback to Constants extra config
  const extra = Constants.expoConfig?.extra ?? (Constants.manifest as any)?.extra ?? {};
  if (extra[key]) return String(extra[key]);

  return fallback;
}

export const SUPPORT_EMAIL = getEnv('EXPO_PUBLIC_SUPPORT_EMAIL', 'support@funxon.co.za');
export const SUPPORT_WHATSAPP = getEnv('EXPO_PUBLIC_SUPPORT_WHATSAPP', '+27837093579');
export const SUPPORT_PHONE = getEnv('EXPO_PUBLIC_SUPPORT_PHONE', '+27837093579');
// PayFast merchant credentials are intentionally NOT in the client bundle.
// They live as Supabase Edge Function secrets (PAYFAST_MERCHANT_ID,
// PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE, PAYFAST_SANDBOX) and are applied
// server-side by the payfast-checkout edge function.
