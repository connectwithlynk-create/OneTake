// Build TranscriptWord[] from a raw script string by estimating
// timing. Used when the target is text (the user hasn't recorded
// audio yet) — the synthesis pipeline + curator need word timestamps
// to slice shots and align b-roll, but the timing only needs to be
// "natural enough" since the user will re-record voiceover at edit time.
//
// Heuristic:
//   - 165 wpm conversational pace = ~360ms/word baseline.
//   - Word length scales duration mildly (~30ms per character).
//   - Sentence-end punctuation (.!?) adds a 250ms pause.
//   - Comma/semicolon adds a 100ms pause.
//   - Paragraph breaks (double newline) add 500ms.
//
// Output is gap-free word timestamps with the cumulative pause baked
// into the next word's start_ms — matches the shape of real Whisper
// output well enough that synthesize() treats it identically.
import type { TranscriptWord } from './transcribe';

const BASE_WORD_MS = 280;
const PER_CHAR_MS = 28;
const SENTENCE_PAUSE_MS = 250;
const CLAUSE_PAUSE_MS = 100;
const PARAGRAPH_PAUSE_MS = 500;

interface Token {
  text: string;
  trailing_pause_ms: number;
}

/** Tokenize the script into words + the pause that should follow each. */
function tokenize(script: string): Token[] {
  // Normalize whitespace; preserve sentence boundary detection by
  // splitting on whitespace but reading the trailing punctuation /
  // newline run after each word.
  const tokens: Token[] = [];
  const re = /(\S+)(\s*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(script)) !== null) {
    const word = match[1];
    const ws = match[2];
    const lastChar = word.slice(-1);
    let pause = 0;
    if (/[.!?]$/.test(lastChar)) pause += SENTENCE_PAUSE_MS;
    else if (/[,;:]$/.test(lastChar)) pause += CLAUSE_PAUSE_MS;
    if (/\n\s*\n/.test(ws)) pause += PARAGRAPH_PAUSE_MS;
    tokens.push({ text: word, trailing_pause_ms: pause });
  }
  return tokens;
}

/** Convert a raw script string into a TranscriptWord[] with estimated
 *  per-word timing. */
export function scriptToTranscriptWords(script: string): TranscriptWord[] {
  const tokens = tokenize(script);
  const words: TranscriptWord[] = [];
  let cursor = 0;
  for (const tok of tokens) {
    const dur = BASE_WORD_MS + tok.text.length * PER_CHAR_MS;
    const start_ms = cursor;
    const end_ms = cursor + dur;
    words.push({ text: tok.text, start_ms, end_ms });
    cursor = end_ms + tok.trailing_pause_ms;
  }
  return words;
}
