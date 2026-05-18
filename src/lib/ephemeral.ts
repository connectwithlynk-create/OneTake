import type { Verdict } from './types';

/**
 * Ephemeral-takes model (the Snapchat-like choice): a take that is not worth
 * keeping disappears on its own; a take you keep becomes a Memory that
 * persists and is eligible for cloud backup.
 *
 * Rule: verdict 'dud' = ephemeral (expires after the window). 'keep' and
 * 'perfect' = saved (no expiry). Re-rating a dud up to keep/perfect clears
 * the expiry, i.e. "keeping it saves it".
 */
export const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function ephemeralExpiry(verdict: Verdict): number | null {
  return verdict === 'dud' ? Date.now() + EPHEMERAL_TTL_MS : null;
}

/** Hours (rounded up, min 1) until an ephemeral clip is swept. */
export function hoursLeft(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / (60 * 60 * 1000)));
}
