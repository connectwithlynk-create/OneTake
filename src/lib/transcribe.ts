import { getClerkInstance } from '@clerk/expo';
import * as LegacyFS from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { resolveClipUri } from './filestore';
import { getClip, setClipAnalysis, setClipRemotePath } from './repo';
import { invalidate } from './store';
import { CLIPS_BUCKET, supabase, supabaseConfigured } from './supabase';
import { uploadClipFile } from './sync';
import type { ClipTag, MetaTag } from './types';

/**
 * Clip analysis (Phase 4, cloud multimodal). Best-effort:
 *  1. upload clip to Storage if needed
 *  2. `transcribe` Edge Function (Deepgram) -> transcript
 *  3. grab a few frames on-device, send frames + transcript to the
 *     `analyze` Edge Function (Claude vision) -> tag, title, content tags
 *  4. persist
 * Vision is the source of truth for talking/b-roll (lens-independent, works
 * even with music over a talking head or someone else filming you). If
 * vision fails, fall back to a transcript-only heuristic; if the whole thing
 * is unavailable (signed out / not configured) it no-ops and the on-device
 * heuristic that already ran stands.
 */
const inFlight = new Set<string>();
const FRAME_FRACTIONS = [0.15, 0.5, 0.85];

function titleFromWords(words: string[]): string {
  let t = words.slice(0, 7).join(' ').replace(/[.,!?;:]+$/, '').trim();
  if (t.length > 42) t = `${t.slice(0, 42).trim()}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function grabFrames(
  fileUri: string,
  durationMs: number
): Promise<string[]> {
  const abs = resolveClipUri(fileUri);
  const dur = durationMs > 0 ? durationMs : 3000;
  const out: string[] = [];
  for (const f of FRAME_FRACTIONS) {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(abs, {
        time: Math.floor(dur * f),
        quality: 0.6,
      });
      const b64 = await LegacyFS.readAsStringAsync(uri, {
        encoding: LegacyFS.EncodingType.Base64,
      });
      if (b64) out.push(b64);
    } catch {
      /* skip a frame that can't be grabbed */
    }
  }
  return out;
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

    // 1. transcript
    const { data: tData, error: tErr } = await supabase.functions.invoke(
      'transcribe',
      { body: { signedUrl: signed.signedUrl } }
    );
    const transcript: string =
      tErr || !tData ? '' : String(tData.transcript ?? '').trim();
    const words = transcript.split(/\s+/).filter(Boolean);

    // 2. vision (frames + transcript)
    const frames = await grabFrames(clip.file_uri, clip.duration_ms);
    let tag: ClipTag = clip.tag;
    let name: string = clip.name ?? 'Clip';
    let metaTags: MetaTag[] | null = null;

    let visionOk = false;
    if (frames.length > 0) {
      const { data: vData, error: vErr } = await supabase.functions.invoke(
        'analyze',
        { body: { transcript, frames } }
      );
      if (!vErr && vData && (vData.tag === 'talking' || vData.tag === 'broll')) {
        tag = vData.tag;
        name =
          typeof vData.title === 'string' && vData.title.trim()
            ? vData.title.trim()
            : clip.name ?? 'Clip';
        metaTags = Array.isArray(vData.tags) ? (vData.tags as MetaTag[]) : [];
        visionOk = true;
      }
    }

    if (!visionOk) {
      // Fallback: transcript-only heuristic.
      const hasSpeech = words.length >= 4;
      tag = hasSpeech ? 'talking' : 'broll';
      name = hasSpeech
        ? clip.order_index === 0
          ? 'Intro'
          : titleFromWords(words)
        : clip.name ?? 'Clip';
    }

    await setClipAnalysis(
      clipId,
      transcript,
      tag,
      name,
      metaTags ? JSON.stringify(metaTags) : clip.meta_tags
    );
    invalidate();
  } catch {
    /* best-effort - heuristic tag/name stays */
  } finally {
    inFlight.delete(clipId);
  }
}
