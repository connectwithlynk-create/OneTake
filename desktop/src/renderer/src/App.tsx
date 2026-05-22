import React, { useState } from 'react';
import type {
  ReelAnalysisResult,
  ResolvedReel,
  ResolveResult,
} from './global';

type Status = 'idle' | 'resolving' | 'done' | 'error';

function isReel(r: ResolveResult): r is ResolvedReel {
  return !('error' in r);
}

export function App(): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [reel, setReel] = useState<ResolvedReel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ReelAnalysisResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  async function resolve(): Promise<void> {
    if (!url.trim()) return;
    setStatus('resolving');
    setReel(null);
    setError(null);
    setAnalysis(null);
    setAnalyzeError(null);
    try {
      const result = await window.api.resolveReel(url.trim());
      if (isReel(result)) {
        setReel(result);
        setStatus('done');
      } else {
        setError(result.error);
        setStatus('error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  async function analyze(): Promise<void> {
    if (!reel) return;
    setAnalyzing(true);
    setAnalysis(null);
    setAnalyzeError(null);
    try {
      const result = await window.api.analyzeReel({
        playableUrl: reel.playable_url,
        durationMs: reel.duration_ms,
      });
      setAnalysis(result);
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  const busy = status === 'resolving';

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">OneTake</span>
        <span className="tag">desktop</span>
      </header>

      <main className="main">
        <label className="label">REEL URL</label>
        <div className="row">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && resolve()}
            placeholder="https://www.youtube.com/shorts/..."
            spellCheck={false}
            autoFocus
          />
          <button className="btn" onClick={resolve} disabled={busy || !url.trim()}>
            {busy ? 'Resolving...' : 'Resolve'}
          </button>
        </div>

        <div className="status">
          <span className={`dot dot-${status}`} />
          {status}
        </div>

        {error && <div className="error">{error}</div>}

        {reel && (
          <div className="result">
            <video className="preview" src={reel.playable_url} controls />
            <dl className="facts">
              <Fact k="platform" v={reel.platform} />
              <Fact k="duration" v={`${(reel.duration_ms / 1000).toFixed(1)}s`} />
              <Fact
                k="size"
                v={reel.width && reel.height ? `${reel.width}x${reel.height}` : 'unknown'}
              />
              <Fact k="captions" v={reel.caption_text ? 'present' : 'none'} />
            </dl>

            <button
              className="btn btn-wide"
              onClick={analyze}
              disabled={analyzing}
            >
              {analyzing ? 'Analyzing...' : 'Analyze reel'}
            </button>

            {analyzeError && <div className="error">{analyzeError}</div>}
            {analysis && <Analysis a={analysis} />}
          </div>
        )}
      </main>
    </div>
  );
}

function Analysis({ a }: { a: ReelAnalysisResult }): React.JSX.Element {
  if (a.shots.length === 0) {
    return (
      <div className="error">
        No shots detected - frame extraction returned nothing. Check that
        ffmpeg is on PATH.
      </div>
    );
  }
  return (
    <div className="analysis">
      <label className="label">METRICS</label>
      <dl className="facts">
        <Fact k="shots" v={String(a.shots.length)} />
        <Fact k="median shot" v={`${a.median_shot_ms}ms`} />
        <Fact k="cuts/sec" v={a.cuts_per_sec.toFixed(2)} />
        <Fact k="text overlay" v={`${Math.round(a.text_overlay_pct * 100)}%`} />
        <Fact k="talking" v={`${Math.round(a.talking_pct * 100)}%`} />
        <Fact k="real speaker" v={`${Math.round(a.real_speaker_pct * 100)}%`} />
        <Fact
          k="b-roll head"
          v={`${Math.round(a.broll_talking_head_pct * 100)}%`}
        />
      </dl>

      <label className="label">HOOK</label>
      <p className="hook">{a.hook_text ?? '(no on-screen text)'}</p>

      <label className="label">SHOTS</label>
      <div className="shots">
        {a.shots.map((s, i) => (
          <div key={i} className="shot">
            <span className="shot-idx">{String(i).padStart(2, '0')}</span>
            <span className="shot-time">
              {s.start_ms}-{s.end_ms}ms
            </span>
            <span className={`shot-speaker sv-${s.speaker_verdict}`}>
              {s.speaker_verdict === 'speaker'
                ? 'speaker'
                : s.speaker_verdict === 'broll'
                  ? 'b-roll head'
                  : s.speaker_verdict === 'no_face'
                    ? 'no face'
                    : '?'}
            </span>
            <span className="shot-text">{s.ocr_text ?? '-'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="fact">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
