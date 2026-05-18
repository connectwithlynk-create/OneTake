import 'react-native-url-polyfill/auto';

import { getClerkInstance } from '@clerk/expo';
import { createClient } from '@supabase/supabase-js';

/**
 * Supabase client wired to Clerk's session token (third-party auth). When
 * `accessToken` is supplied, supabase-js sends that JWT and does not manage
 * its own session/storage. Postgres RLS resolves the Clerk user id via
 * auth.jwt()->>'sub'.
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const key = process.env.EXPO_PUBLIC_SUPABASE_KEY ?? '';

export const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  async accessToken() {
    try {
      return (await getClerkInstance().session?.getToken()) ?? null;
    } catch {
      return null;
    }
  },
});

export const CLIPS_BUCKET = 'clips';

/** Configured only if both env vars are present (lets the app run locally
 *  with no backend before keys are added). */
export const supabaseConfigured = Boolean(url && key);
