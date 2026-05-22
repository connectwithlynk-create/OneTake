import { supabase, supabaseConfigured } from './supabase';
import type { ResolvedReel } from './repo';

/** Dev-only escape hatch. When set, the resolver hits a local stealth-
 *  browser service instead of the `resolve-reel` edge function, which
 *  YouTube bot-walls from Supabase's datacenter IP. See
 *  scripts/local-resolver/. */
const LOCAL_RESOLVER_URL = process.env.EXPO_PUBLIC_LOCAL_RESOLVER_URL;

/**
 * Resolve a reel/short share URL to a streamable mp4 + raw media facts
 * by calling the `resolve-reel` Supabase Edge Function. Throws on any
 * non-2xx response so callers can surface the error and transition the
 * inspiration to analysis_status='failed' if appropriate.
 */
export async function resolveReelUrl(sourceUrl: string): Promise<ResolvedReel> {
  if (LOCAL_RESOLVER_URL) {
    const res = await fetch(LOCAL_RESOLVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    });
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      throw new Error('local resolver returned no data');
    }
    if ('error' in data && typeof data.error === 'string') {
      throw new Error(data.error);
    }
    return data as ResolvedReel;
  }

  if (!supabaseConfigured) {
    throw new Error('Supabase not configured (set EXPO_PUBLIC_SUPABASE_URL)');
  }
  const { data, error } = await supabase.functions.invoke('resolve-reel', {
    body: { url: sourceUrl },
  });
  if (error) {
    // supabase-js wraps non-2xx as FunctionsHttpError with .message.
    throw new Error(error.message || 'resolver failed');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('resolver returned no data');
  }
  // Edge fn returns { error } on failure with status 4xx/5xx; supabase-js
  // surfaces those via `error` above. Defensive guard for the success path.
  if ('error' in data && typeof data.error === 'string') {
    throw new Error(data.error);
  }
  return data as ResolvedReel;
}
