/**
 * Speech-presence classification from audio metering samples (no LLM, no
 * model). expo-audio reports metering in dBFS (0 = max, more negative =
 * quieter). Sustained audible level across the clip => someone is talking;
 * mostly silence => b-roll. This is loudness/presence, not recognition:
 * loud music or ambient noise can read as "talking". Returns undefined when
 * there isn't enough data (e.g. the parallel recorder couldn't run), so the
 * caller falls back to the lens heuristic.
 */
export const SPEECH_DB_THRESHOLD = -40; // above this ~ audible voice/sound
export const SPEECH_MIN_SAMPLES = 4;
export const SPEECH_MIN_RATIO = 0.3;

export function classifySpeech(samples: number[]): boolean | undefined {
  const valid = samples.filter((s) => Number.isFinite(s));
  if (valid.length < SPEECH_MIN_SAMPLES) return undefined;
  const loud = valid.filter((s) => s > SPEECH_DB_THRESHOLD).length;
  return loud / valid.length >= SPEECH_MIN_RATIO;
}
