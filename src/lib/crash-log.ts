import { File, Paths } from 'expo-file-system';

/**
 * Lightweight on-device crash + error log. Captures three things:
 *   1. Unhandled JS errors (ErrorUtils.setGlobalHandler).
 *   2. React render errors (paired with components/error-boundary).
 *   3. Manual breadcrumbs from hot paths the bug is hiding in
 *      (editor scroll/seek/setClips, native onStatusChange).
 *
 * Entries persist as JSONL in the app's document dir so they survive
 * an app crash + relaunch. The /debug-crash screen renders them; users
 * can also Share the file to ship logs out.
 *
 * Not a substitute for Sentry / PLCrashReporter — Swift fatal errors
 * and signals (SIGSEGV, OOM-jetsam) don't reach JS. For those, watch
 * the native NSLog stream (Console.app or `xcrun simctl spawn booted
 * log stream --predicate 'process == "OneTake"'`).
 */

const LOG_FILE = 'crash-log.jsonl';
const JS_CRUMB_FILE = 'js-breadcrumbs.jsonl';
const NATIVE_CRUMB_FILE = 'native-breadcrumbs.jsonl';
const MAX_LOG_BYTES = 256 * 1024; // 256 KB rolling cap
const MAX_CRUMB_BYTES = 96 * 1024; // 96 KB rolling cap per crumb file
const BREADCRUMB_LIMIT = 200;

export type Severity = 'info' | 'warn' | 'error' | 'fatal';

export interface Breadcrumb {
  ts: number;
  source: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface LogEntry {
  ts: string;
  sev: Severity;
  source: string;
  message: string;
  stack?: string;
  data?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
}

const breadcrumbs: Breadcrumb[] = [];

// Batched persist queue — drains every ~200ms or when 8 entries pile up.
// In-memory only would lose everything when iOS kills the app silently
// (jetsam / watchdog), which is exactly the case we're trying to debug.
const pendingPersist: Breadcrumb[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPersist();
  }, 200);
}

function flushPersist() {
  if (pendingPersist.length === 0) return;
  const lines = pendingPersist.map((b) => JSON.stringify(b)).join('\n') + '\n';
  pendingPersist.length = 0;
  try {
    const f = new File(Paths.document, JS_CRUMB_FILE);
    // Lazy rollover.
    if (f.exists) {
      const size = (f as unknown as { size?: number }).size ?? 0;
      if (size > MAX_CRUMB_BYTES) {
        try {
          const text = f.textSync();
          const tail = text.slice(-Math.floor(MAX_CRUMB_BYTES / 2));
          const nl = tail.indexOf('\n');
          f.write(nl >= 0 ? tail.slice(nl + 1) : tail);
        } catch {
          /* */
        }
      }
    }
    f.write(lines, { append: true });
  } catch {
    /* */
  }
}

/** Drop a breadcrumb. Cheap (in-memory) but also queued for batched
 *  persist — so when the next thing that happens is iOS killing the
 *  process, the trail survives to the next launch. */
export function crumb(
  source: string,
  msg: string,
  data?: Record<string, unknown>
) {
  const b: Breadcrumb = { ts: Date.now(), source, msg, data };
  breadcrumbs.push(b);
  if (breadcrumbs.length > BREADCRUMB_LIMIT) breadcrumbs.shift();
  pendingPersist.push(b);
  if (pendingPersist.length >= 8) {
    flushPersist();
  } else {
    scheduleFlush();
  }
}

/** Force a flush of pending breadcrumbs to disk. Call this before a
 *  known-risky op so the trail is current when iOS terminates us. */
export function flushBreadcrumbs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushPersist();
}

function logFile(): File {
  return new File(Paths.document, LOG_FILE);
}

/** Roll the file if it's exceeded MAX_LOG_BYTES — keep the tail.
 *  Avoids unbounded growth on noisy days. */
function rollIfNeeded(f: File) {
  try {
    if (!f.exists) return;
    const size = (f as unknown as { size?: number }).size ?? 0;
    if (size <= MAX_LOG_BYTES) return;
    const text = f.textSync();
    const tail = text.slice(-Math.floor(MAX_LOG_BYTES / 2));
    // Chop the partial leading line off so the JSONL stays parseable.
    const nl = tail.indexOf('\n');
    const cleaned = nl >= 0 ? tail.slice(nl + 1) : tail;
    f.write(cleaned);
  } catch {
    /* best effort */
  }
}

function appendEntry(entry: LogEntry) {
  try {
    const f = logFile();
    rollIfNeeded(f);
    const line = JSON.stringify(entry) + '\n';
    f.write(line, { append: true });
  } catch {
    /* swallow — IO failure can't itself crash the app */
  }
}

function attachBreadcrumbs(): Breadcrumb[] {
  // Copy so the persisted entry isn't mutated by later crumbs.
  return breadcrumbs.slice();
}

export function recordInfo(
  source: string,
  message: string,
  data?: Record<string, unknown>
) {
  appendEntry({
    ts: new Date().toISOString(),
    sev: 'info',
    source,
    message,
    data,
  });
}

export function recordError(
  err: unknown,
  source: string,
  data?: Record<string, unknown>
) {
  const e = err instanceof Error ? err : new Error(String(err));
  appendEntry({
    ts: new Date().toISOString(),
    sev: 'error',
    source,
    message: e.message,
    stack: e.stack,
    data,
    breadcrumbs: attachBreadcrumbs(),
  });
  // Surface in dev so the user sees it in Metro too.
  console.error(`[crash-log:${source}]`, e.message, data ?? '');
}

export function recordFatal(
  err: unknown,
  source: string,
  data?: Record<string, unknown>
) {
  const e = err instanceof Error ? err : new Error(String(err));
  appendEntry({
    ts: new Date().toISOString(),
    sev: 'fatal',
    source,
    message: e.message,
    stack: e.stack,
    data,
    breadcrumbs: attachBreadcrumbs(),
  });
  console.error(`[crash-log:FATAL:${source}]`, e.message, data ?? '');
}

export function readCrashLog(): LogEntry[] {
  try {
    const f = logFile();
    if (!f.exists) return [];
    const text = f.textSync();
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogEntry => x !== null);
  } catch {
    return [];
  }
}

export function clearCrashLog() {
  try {
    const f = logFile();
    if (f.exists) f.delete();
    const jc = new File(Paths.document, JS_CRUMB_FILE);
    if (jc.exists) jc.delete();
    const nc = new File(Paths.document, NATIVE_CRUMB_FILE);
    if (nc.exists) nc.delete();
    breadcrumbs.length = 0;
    pendingPersist.length = 0;
  } catch {
    /* */
  }
}

/** Read persisted breadcrumbs from the JS-side file (this run + prior
 *  runs that didn't get flushed into a crash entry). */
export function readJsBreadcrumbs(): Breadcrumb[] {
  return readCrumbFile(JS_CRUMB_FILE);
}

/** Read persisted breadcrumbs from the native module (NleEngine etc).
 *  Crucial when iOS kills the process — this is the trail Metro can't
 *  show. Entries use `ts` in ms epoch and have `source` + `msg`. */
export function readNativeBreadcrumbs(): Breadcrumb[] {
  return readCrumbFile(NATIVE_CRUMB_FILE);
}

function readCrumbFile(name: string): Breadcrumb[] {
  try {
    const f = new File(Paths.document, name);
    if (!f.exists) return [];
    const text = f.textSync();
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Breadcrumb;
        } catch {
          return null;
        }
      })
      .filter((x): x is Breadcrumb => x !== null);
  } catch {
    return [];
  }
}

export function crashLogFileUri(): string | null {
  try {
    const f = logFile();
    return f.exists ? f.uri : null;
  } catch {
    return null;
  }
}

/** Write a combined human-readable report (crash entries + both
 *  breadcrumb files, ordered by time) to a single file and return its
 *  URI. Use this for sharing — single attachment, no truncation. */
export function buildCombinedReport(): string | null {
  try {
    const lines: string[] = [];
    lines.push('=== OneTake crash report ===');
    lines.push(`generated: ${new Date().toISOString()}`);
    lines.push('');

    const errors = readCrashLog();
    lines.push(`=== Crash entries (${errors.length}) ===`);
    for (const e of errors) {
      lines.push('');
      lines.push(
        `[${e.ts}] ${e.sev.toUpperCase()} ${e.source}: ${e.message}`
      );
      if (e.data) lines.push('  data: ' + JSON.stringify(e.data));
      if (e.stack) {
        lines.push('  stack:');
        for (const sl of e.stack.split('\n')) lines.push('    ' + sl);
      }
      if (e.breadcrumbs && e.breadcrumbs.length > 0) {
        lines.push(`  breadcrumbs (${e.breadcrumbs.length}):`);
        for (const b of e.breadcrumbs) {
          lines.push(
            `    ${new Date(b.ts).toISOString()} [${b.source}] ${b.msg}` +
              (b.data ? ' ' + JSON.stringify(b.data) : '')
          );
        }
      }
    }

    const trace = [...readJsBreadcrumbs(), ...readNativeBreadcrumbs()];
    trace.sort((a, b) => a.ts - b.ts);
    lines.push('');
    lines.push(`=== Persistent trace (${trace.length} crumbs) ===`);
    for (const b of trace) {
      lines.push(
        `${new Date(b.ts).toISOString()} [${b.source}] ${b.msg}` +
          (b.data ? ' ' + JSON.stringify(b.data) : '')
      );
    }

    const out = new File(Paths.document, 'crash-report.txt');
    out.write(lines.join('\n'));
    return out.uri;
  } catch {
    return null;
  }
}

/** Install global JS error capture. Safe to call once at app boot. */
export function initCrashLog() {
  type EU = {
    getGlobalHandler?: () => (err: Error, isFatal?: boolean) => void;
    setGlobalHandler?: (
      h: (err: Error, isFatal?: boolean) => void
    ) => void;
  };
  const g = globalThis as unknown as { ErrorUtils?: EU };
  const prev = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    if (isFatal) {
      recordFatal(error, 'js-global');
    } else {
      recordError(error, 'js-global');
    }
    if (prev) {
      try {
        prev(error, isFatal);
      } catch {
        /* */
      }
    }
  });

  // Unhandled promise rejections. RN ships with promise-rejection-tracking
  // but we don't want to take a hard dep on its internals; the global
  // 'unhandledrejection' event covers most cases on newer RN.
  try {
    const ev = (globalThis as unknown as {
      addEventListener?: (k: string, h: (e: { reason?: unknown }) => void) => void;
    }).addEventListener;
    ev?.('unhandledrejection', (e) => {
      recordError(e?.reason ?? 'unhandledrejection', 'js-unhandled-rejection');
    });
  } catch {
    /* */
  }
  crumb('crash-log', 'init');
}
