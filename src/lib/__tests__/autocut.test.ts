import { buildAutoCut } from '../autocut';
import { EDL_VERSION } from '../edl';
import type { Clip } from '../types';

/** Clip factory: sane defaults, override only what a test cares about. */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    project_id: 'p1',
    order_index: 0,
    file_uri: 'clips/c1.mov',
    duration_ms: 3000,
    verdict: 'keep',
    verdict_overridden: 0,
    tag: 'talking',
    tag_overridden: 0,
    excluded: 0,
    name: null,
    meta_tags: null,
    transcript: null,
    mirrored: 0,
    in_ms: null,
    out_ms: null,
    audio_volume: 1,
    transcript_words: null,
    expires_at: null,
    remote_path: null,
    created_at: 1000,
    owner: null,
    updated_at: 0,
    sync_status: 'local',
    ...over,
  };
}

describe('buildAutoCut', () => {
  it('rule 1: drops a non-overridden dud', () => {
    const edl = buildAutoCut([clip({ id: 'a', verdict: 'dud', verdict_overridden: 0 })]);
    expect(edl.tracks.video).toHaveLength(0);
  });

  it('rule 1: KEEPS a user-overridden dud', () => {
    const edl = buildAutoCut([clip({ id: 'a', verdict: 'dud', verdict_overridden: 1 })]);
    expect(edl.tracks.video.map((v) => v.clipId)).toEqual(['a']);
  });

  it('rule 2: drops excluded clips', () => {
    const edl = buildAutoCut([
      clip({ id: 'a', excluded: 1 }),
      clip({ id: 'b', excluded: 0 }),
    ]);
    expect(edl.tracks.video.map((v) => v.clipId)).toEqual(['b']);
  });

  it('rule 3+4: all talking before all b-roll', () => {
    const edl = buildAutoCut([
      clip({ id: 'b1', tag: 'broll', order_index: 0 }),
      clip({ id: 't1', tag: 'talking', order_index: 1 }),
      clip({ id: 'b2', tag: 'broll', order_index: 2 }),
      clip({ id: 't2', tag: 'talking', order_index: 3 }),
    ]);
    expect(edl.tracks.video.map((v) => v.clipId)).toEqual(['t1', 't2', 'b1', 'b2']);
  });

  it('rule 4: within a group, order_index asc then created_at then id', () => {
    const edl = buildAutoCut([
      clip({ id: 'z', tag: 'talking', order_index: 5, created_at: 100 }),
      clip({ id: 'a', tag: 'talking', order_index: 5, created_at: 100 }), // id tie-break
      clip({ id: 'm', tag: 'talking', order_index: 5, created_at: 50 }), // created_at tie-break
      clip({ id: 'first', tag: 'talking', order_index: 1, created_at: 999 }),
    ]);
    expect(edl.tracks.video.map((v) => v.clipId)).toEqual(['first', 'm', 'a', 'z']);
  });

  it('rule 5: verdict does NOT reorder (perfect after keep keeps capture order)', () => {
    const edl = buildAutoCut([
      clip({ id: 'keep1', verdict: 'keep', order_index: 0 }),
      clip({ id: 'perfect1', verdict: 'perfect', order_index: 1 }),
    ]);
    expect(edl.tracks.video.map((v) => v.clipId)).toEqual(['keep1', 'perfect1']);
  });

  it('rule 6: each clip -> inMs=0, outMs=duration_ms, speed=1, transitionOut=null', () => {
    const edl = buildAutoCut([clip({ id: 'a', duration_ms: 4200 })]);
    expect(edl.tracks.video[0]).toEqual({
      clipId: 'a',
      inMs: 0,
      outMs: 4200,
      speed: 1.0,
      transitionOut: null,
    });
  });

  it('EDL shape: version stamped, overlays/audio empty in v1', () => {
    const edl = buildAutoCut([clip()]);
    expect(edl.version).toBe(EDL_VERSION);
    expect(edl.tracks.overlays).toEqual([]);
    expect(edl.tracks.audio).toEqual([]);
  });

  it('empty input -> valid empty EDL, not a crash', () => {
    const edl = buildAutoCut([]);
    expect(edl).toEqual({
      version: EDL_VERSION,
      tracks: { video: [], overlays: [], audio: [] },
    });
  });

  it('all clips dropped -> valid empty EDL', () => {
    const edl = buildAutoCut([
      clip({ id: 'a', verdict: 'dud', verdict_overridden: 0 }),
      clip({ id: 'b', excluded: 1 }),
    ]);
    expect(edl.tracks.video).toHaveLength(0);
  });

  it('is deterministic: same input -> byte-identical output', () => {
    const input = [
      clip({ id: 'b1', tag: 'broll', order_index: 2 }),
      clip({ id: 't1', tag: 'talking', order_index: 1 }),
      clip({ id: 't2', tag: 'talking', order_index: 0 }),
    ];
    expect(JSON.stringify(buildAutoCut(input))).toBe(
      JSON.stringify(buildAutoCut(input))
    );
  });

  it('does NOT mutate the input array or its order', () => {
    const input = [
      clip({ id: 'b1', tag: 'broll', order_index: 0 }),
      clip({ id: 't1', tag: 'talking', order_index: 1 }),
    ];
    const snapshot = input.map((c) => c.id);
    buildAutoCut(input);
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });
});
