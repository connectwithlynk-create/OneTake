import { supabase, supabaseConfigured } from './supabase';
import type { ResolvedReel } from './repo';

/**
 * Resolve a reel/short share URL to a streamable mp4 + raw media facts
 * by calling the `resolve-reel` Supabase Edge Function. Throws on any
 * non-2xx response so callers can surface the error and transition the
 * inspiration to analysis_status='failed' if appropriate.
 */
export async function resolveReelUrl(sourceUrl: string): Promise<ResolvedReel> {
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
