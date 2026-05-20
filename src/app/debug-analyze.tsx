import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Header, MonoLabel, Screen } from '@/components/ui';
import {
  runAnalysisForInspiration,
  type ReelAnalysisResult,
} from '@/lib/analyze';
import {
  addInspiration,
  detectPlatform,
  setInspirationResolved,
} from '@/lib/repo';
import { resolveReelUrl } from '@/lib/resolve';
import { invalidate } from '@/lib/store';
import { font, palette } from '@/theme';

/**
 * Phase-1 dev tool. Paste a playable mp4 URL + duration, runs the full
 * on-device analysis pipeline against a fresh Inspiration row, and
 * shows the result. Bypasses the URL resolver (task #1) - that's the
 * source URL field's only job here.
 */
export default function DebugAnalyzeScreen() {
  const [sourceUrl, setSourceUrl] = useState('');
  const [playableUrl, setPlayableUrl] = useState('');
  const [durationStr, setDurationStr] = useState('30000');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('idle');
  const [result, setResult] = useState<ReelAnalysisResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setStatus('queued');
    setResult(null);
    setErrorMsg(null);
    try {
      const insp = await addInspiration(
        '',
        sourceUrl || playableUrl,
        'debug-analyze'
      );

      // Two paths: if a Playable URL is given, skip the resolver (bypass
      // for local testing). Otherwise call the edge function with the
      // source URL to populate playable_url + duration_ms + captions.
      if (playableUrl) {
        const durationMs = parseInt(durationStr, 10);
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
          throw new Error('Bad duration_ms');
        }
        await setInspirationResolved(insp.id, {
          platform: sourceUrl ? detectPlatform(sourceUrl) : 'unknown',
          playable_url: playableUrl,
          playable_url_expires_at: null,
          duration_ms: durationMs,
          width: null,
          height: null,
          caption_text: null,
        });
      } else {
        if (!sourceUrl) throw new Error('Source URL or playable URL required');
        setStatus('resolving');
        const resolved = await resolveReelUrl(sourceUrl);
        await setInspirationResolved(insp.id, resolved);
        setDurationStr(String(resolved.duration_ms));
        setPlayableUrl(resolved.playable_url);
      }

      setStatus('running');
      const out = await runAnalysisForInspiration(insp.id);
      invalidate();
      if (out.ok && out.result) {
        setStatus('ready');
        setResult(out.result);
      } else {
        setStatus('failed');
        setErrorMsg(out.reason ?? 'unknown error');
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      setStatus('failed');
      setErrorMsg(m);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Screen pad={false}>
      <Header title="Debug analyze" back />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 60 }}>
        <MonoLabel style={{ marginBottom: 8 }}>SOURCE URL (DISPLAY)</MonoLabel>
        <View style={s.field}>
          <TextInput
            value={sourceUrl}
            onChangeText={setSourceUrl}
            placeholder="https://www.youtube.com/shorts/..."
            placeholderTextColor={palette.text3}
            autoCapitalize="none"
            keyboardType="url"
            style={s.fieldMono}
          />
        </View>

        <MonoLabel style={{ marginTop: 14, marginBottom: 8 }}>
          PLAYABLE MP4 URL
        </MonoLabel>
        <View style={s.field}>
          <TextInput
            value={playableUrl}
            onChangeText={setPlayableUrl}
            placeholder="https://...mp4 (skips resolver, task #1)"
            placeholderTextColor={palette.text3}
            autoCapitalize="none"
            keyboardType="url"
            style={s.fieldMono}
          />
        </View>

        <MonoLabel style={{ marginTop: 14, marginBottom: 8 }}>
          DURATION (MS)
        </MonoLabel>
        <View style={s.field}>
          <TextInput
            value={durationStr}
            onChangeText={setDurationStr}
            keyboardType="numeric"
            style={s.fieldMono}
          />
        </View>

        <View style={{ marginTop: 18 }}>
          <Button
            label={running ? 'Analyzing…' : 'Resolve + analyze'}
            icon="play"
            size="lg"
            full
            disabled={running || (!playableUrl && !sourceUrl)}
            onPress={run}
          />
        </View>

        <View style={s.statusRow}>
          <MonoLabel>STATUS</MonoLabel>
          <Text style={s.statusText}>{status}</Text>
        </View>
        {errorMsg ? <Text style={s.error}>{errorMsg}</Text> : null}

        {result ? <ResultView r={result} /> : null}
      </ScrollView>
    </Screen>
  );
}

function ResultView({ r }: { r: ReelAnalysisResult }) {
  return (
    <View style={{ marginTop: 18, gap: 6 }}>
      <MonoLabel style={{ marginBottom: 4 }}>HOOK</MonoLabel>
      <Text style={s.body}>{r.hook_text ?? '(none)'}</Text>
      <Text style={s.subtle}>
        hook_duration_ms = {r.hook_duration_ms ?? 'null'}
      </Text>

      <MonoLabel style={{ marginTop: 14, marginBottom: 4 }}>METRICS</MonoLabel>
      <Text style={s.body}>
        median_shot_ms = {r.median_shot_ms}
        {'\n'}cuts_per_sec = {r.cuts_per_sec.toFixed(3)}
        {'\n'}talking_pct = {(r.talking_pct * 100).toFixed(1)}%
        {'\n'}broll_pct = {(r.broll_pct * 100).toFixed(1)}%
        {'\n'}text_overlay_pct = {(r.text_overlay_pct * 100).toFixed(1)}%
      </Text>

      <MonoLabel style={{ marginTop: 14, marginBottom: 4 }}>
        SHOTS ({r.shots.length})
      </MonoLabel>
      {r.shots.map((sh, i) => (
        <View key={i} style={s.shotRow}>
          <Text style={s.shotIdx}>{i.toString().padStart(2, '0')}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.shotMeta}>
              {sh.start_ms}–{sh.end_ms}ms · {sh.has_face ? 'talking' : 'broll'}
              {sh.ocr_text ? ' · TEXT' : ''}
            </Text>
            {sh.ocr_text ? (
              <Text style={s.shotOcr}>{sh.ocr_text}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  field: {
    backgroundColor: palette.bg1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  fieldMono: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: '#fff',
    fontFamily: font.mono,
    fontSize: 13,
  },
  statusRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusText: {
    fontFamily: font.monoBold,
    fontSize: 13,
    color: palette.lime,
  },
  error: {
    marginTop: 8,
    fontFamily: font.mono,
    fontSize: 12,
    color: palette.coral,
  },
  body: {
    fontFamily: font.body,
    fontSize: 14,
    color: '#fff',
  },
  subtle: {
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text3,
  },
  shotRow: {
    paddingVertical: 8,
    flexDirection: 'row',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  shotIdx: {
    fontFamily: font.monoBold,
    fontSize: 12,
    color: palette.cyan,
    width: 24,
  },
  shotMeta: {
    fontFamily: font.mono,
    fontSize: 12,
    color: palette.text2,
  },
  shotOcr: {
    marginTop: 2,
    fontFamily: font.bodyBold,
    fontSize: 13,
    color: '#fff',
  },
});
