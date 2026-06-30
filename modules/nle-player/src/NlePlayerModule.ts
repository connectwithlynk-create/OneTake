import { NativeModule, requireOptionalNativeModule } from 'expo';

import {
  NleClip,
  NleNativeErrorEvent,
  NlePlayerModuleEvents,
  NleTimeUpdateEvent,
  NlePlayingChangeEvent,
  NleStatusChangeEvent,
  NlePlayToEndEvent,
} from './NlePlayer.types';

/** Static native module. Owns the player registry; the JS-side NlePlayer
 *  class wraps a handle returned by create(). */
declare class NlePlayerNative extends NativeModule<NlePlayerModuleEvents> {
  /** Create a new native player instance. Returns its handle (int >= 0). */
  create(): number;
  /** Tear down a native player. */
  destroy(handle: number): void;
  /** Replace the player's composed timeline. Synchronous on the JS side
   *  but the native composition is built and the player primed
   *  asynchronously; subscribe to onStatusChange to know when it's
   *  ready. */
  setClips(handle: number, clips: NleClip[]): void;
  play(handle: number): void;
  pause(handle: number): void;
  /** Seek by composed-timeline milliseconds. */
  seek(handle: number, ms: number): void;
  /** Toggle scrub mode. When true, the native CIFilter handler skips
   *  color / chroma / cutout processing and renders the raw oriented
   *  frame — much cheaper, and avoids the Vision concurrency hazard
   *  that's the prime suspect for crashes during fast scrub. */
  setScrubbing(handle: number, on: boolean): void;
  /** Synchronous reads for hot paths. Falls back to 0 if the handle is
   *  unknown or the player isn't ready yet. */
  getCurrentTime(handle: number): number;
  getDuration(handle: number): number;
  getIsPlaying(handle: number): boolean;
  /** Apply per-clip volume without rebuilding the composition. */
  setClipVolume(handle: number, clipId: string, volume: number): void;
}

const Native = requireOptionalNativeModule<NlePlayerNative>('NlePlayer');

export const isNlePlayerAvailable = Native != null;

function unavailable(): never {
  throw new Error(
    'NlePlayer is not available in Expo Go. Use a development build to use the native editor player.'
  );
}

function getNative(): NlePlayerNative {
  if (!Native) unavailable();
  return Native;
}

export default Native;

/** Subscribe to native-side errors (caught throws inside NleEngine,
 *  composition build failures, etc.). Returns an unsubscribe fn.
 *  Independent of any player handle — install once at app boot. */
export function attachNativeErrorListener(
  handler: (payload: NleNativeErrorEvent) => void
): () => void {
  if (!Native) return () => {};
  const sub = Native.addListener('onNativeError', handler as never);
  return () => sub.remove();
}

/** Imperative wrapper around a single native player handle. Mirrors the
 *  shape of expo-video's `useVideoPlayer` returned object so the editor
 *  can substitute it with minimal churn. */
export class NlePlayer {
  /** Native handle. -1 once destroyed. */
  private _handle: number;
  private _subs: Array<{ remove(): void }> = [];

  constructor() {
    this._handle = getNative().create();
  }

  get handle(): number {
    return this._handle;
  }

  setClips(clips: NleClip[]) {
    if (this._handle < 0) return;
    getNative().setClips(this._handle, clips);
  }

  play() {
    if (this._handle < 0) return;
    getNative().play(this._handle);
  }
  pause() {
    if (this._handle < 0) return;
    getNative().pause(this._handle);
  }
  seek(ms: number) {
    if (this._handle < 0) return;
    getNative().seek(this._handle, ms);
  }
  setScrubbing(on: boolean) {
    if (this._handle < 0) return;
    getNative().setScrubbing(this._handle, on);
  }
  setClipVolume(clipId: string, volume: number) {
    if (this._handle < 0) return;
    getNative().setClipVolume(this._handle, clipId, volume);
  }

  get currentTime(): number {
    if (this._handle < 0) return 0;
    return getNative().getCurrentTime(this._handle);
  }
  get duration(): number {
    if (this._handle < 0) return 0;
    return getNative().getDuration(this._handle);
  }
  get isPlaying(): boolean {
    if (this._handle < 0) return false;
    return getNative().getIsPlaying(this._handle);
  }

  /** Subscribe to a player-scoped event. Native filters by handle so
   *  listeners on different player instances don't cross-fire. */
  addListener<K extends keyof NlePlayerModuleEvents>(
    event: K,
    listener: (payload: Parameters<NlePlayerModuleEvents[K]>[0]) => void
  ): { remove: () => void } {
    const wrapped = (
      payload: Parameters<NlePlayerModuleEvents[K]>[0] & { handle?: number }
    ) => {
      if (payload?.handle !== undefined && payload.handle !== this._handle) {
        return;
      }
      listener(payload);
    };
    const sub = getNative().addListener(event, wrapped as never);
    this._subs.push(sub);
    return {
      remove: () => {
        sub.remove();
        this._subs = this._subs.filter((s) => s !== sub);
      },
    };
  }

  destroy() {
    if (this._handle < 0) return;
    for (const s of this._subs) {
      try {
        s.remove();
      } catch {
        /* ignore */
      }
    }
    this._subs = [];
    getNative().destroy(this._handle);
    this._handle = -1;
  }
}

export type {
  NleClip,
  NleNativeErrorEvent,
  NleTimeUpdateEvent,
  NlePlayingChangeEvent,
  NleStatusChangeEvent,
  NlePlayToEndEvent,
};
