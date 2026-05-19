import { getClerkInstance } from '@clerk/expo';

import {
  getClip,
  setClipRemotePath,
  setClipTranscription,
} from './repo';
import { invalidate } from './store';
import { CLIPS_BUCKET, supabase, supabaseConfigured } from './supabase';
import { uploadClipFile } from './sync';
import type { ClipTag } from './types';

/**
 * Server transcription (Phase 4). Best-effort and lens-independent:
 * uploads the clip to Storage if needed, has the `transcribe` Edge Function
 * (which holds the Deepgram key) transcribe it, then derives the real
 * talking/b-roll tag and a spoken-words title from the transcript.
 *
 * Requires: Supabase configured, signed in (Clerk), and the Clerk<->Supabase
 * integration set up. Otherwise it silently no-ops and the lens/audio
 * heuristic that already ran stands.
 */
const inFlight = new Set<string>();

function titleFrom(words: string[]): string {
  let t = words.slice(0, 7).join(' ').replace(/[.,!?;:]+$/, '').trim();
  if (t.length > 42) t = `${t.slice(0, 42).trim()}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export async function maybeTranscribe(clipId: string): Promise<void> {
  if (!supabaseConfigured || inFlight.has(clipId)) return;
  let userId: string | undefined;
  try {
    userId = getClerkInstance().user?.id ?? undefined;
  } catch {
    userId = undefined;
  }
  if (!userId) return;

  inFlight.add(clipId);
  try {
    const clip = await getClip(clipId);
    if (!clip) return;

    let storagePath = clip.remote_path;
    if (!storagePath) {
      storagePath = await uploadClipFile(userId, clip);
      if (storagePath) await setClipRemotePath(clipId, storagePath);
    }
    if (!storagePath) return;

    const { data: signed, error: signErr } = await supabase.storage
      .from(CLIPS_BUCKET)
      .createSignedUrl(storagePath, 120);
    if (signErr || !signed?.signedUrl) return;

    const { data, error } = await supabase.functions.invoke('transcribe', {
      body: { signedUrl: signed.signedUrl },
    });
    if (error || !data) return;
    const transcript: string = String(data.transcript ?? '').trim();

    const words = transcript.split(/\s+/).filter(Boolean);
    const hasSpeech = words.length >= 4;
    const tag: ClipTag = hasSpeech ? 'talking' : 'broll';
    // Title from the actual spoken words; the project's opener is the Intro.
    let name = clip.name ?? '';
    if (hasSpeech) {
      name = clip.order_index === 0 ? 'Intro' : titleFrom(words);
    }

    await setClipTranscription(clipId, transcript, tag, name);
    invalidate();
  } catch {
    /* best-effort - heuristic tag/name stays */
  } finally {
    inFlight.delete(clipId);
  }
}
