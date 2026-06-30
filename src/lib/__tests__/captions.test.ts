import { lineifyProject } from '../captions';
import type { Clip } from '../types';

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    project_id: 'p1',
    order_index: 0,
    file_uri: 'clips/c1.mov',
    duration_ms: 5000,
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
    audio_detached: 0,
    transcript_words: null,
    effects_json: null,
    expires_at: null,
    remote_path: null,
    created_at: 1000,
    owner: null,
    updated_at: 0,
    sync_status: 'local',
    ...over,
  };
}

describe('lineifyProject', () => {
  it('remaps word timings to composed timeline time', () => {
    const lines = lineifyProject(
      [
        clip({
          transcript_words: JSON.stringify([
            { w: 'first', s: 0.9, e: 1.1 },
            { w: 'spoken', s: 1.2, e: 1.5 },
          ]),
          in_ms: 1000,
          out_ms: 2000,
        }),
      ],
      [3000]
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].startMs).toBe(3000);
    expect(lines[0].endMs).toBe(3500);
    expect(lines[0].text).toBe('first spoken');
    expect(lines[0].words).toEqual([
      { w: 'first', s: 3, e: 3.1 },
      { w: 'spoken', s: 3.2, e: 3.5 },
    ]);
  });
});
