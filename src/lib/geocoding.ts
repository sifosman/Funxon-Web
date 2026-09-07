// Address helpers shared by the application + checkout save paths.
// Coordinates come from the geocode-address edge function (server-side Google
// key), so no Google key is needed in the client bundle.

import { supabase } from './supabaseClient';

export type GeocodeResult = { latitude: number; longitude: number };

/** Collapse newlines/multi-spaces and trim. Returns null for empty input. */
export function normalizeAddress(value?: string | null): string | null {
  if (!value) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean || null;
}

/**
 * Resolve an address string to coordinates. Returns null (never throws) so
 * saving a listing can proceed without a map pin when geocoding fails.
 */
export async function geocodeAddress(address?: string | null): Promise<GeocodeResult | null> {
  const clean = normalizeAddress(address);
  if (!clean || clean.length < 4) return null;

  try {
    const { data, error } = await supabase.functions.invoke('geocode-address', {
      body: { address: clean },
    });
    if (error) {
      console.warn('geocode-address failed:', error.message);
      return null;
    }
    const latitude = Number(data?.latitude);
    const longitude = Number(data?.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
    return null;
  } catch (err) {
    console.warn('geocodeAddress exception:', err);
    return null;
  }
}
