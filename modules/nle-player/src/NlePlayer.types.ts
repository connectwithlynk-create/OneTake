import type { StyleProp, ViewStyle } from 'react-native';

/** One clip on the timeline. The native side composes these into a single
 *  playable timeline (AVMutableComposition / ConcatenatingMediaSource). */
export type NleClip = {
  /** Stable id; surfaced back in events so the JS side can map a current
   *  playback time to the source clip. */
  id: string;
  /** Absolute file URI (file://...) or asset URL the native layer can open. */
  uri: string;
  /** Trim in/out (milliseconds) from the source file. */
  inMs: number;
  outMs: number;
  /** Per-clip audio volume (0..1). Defaults to 1. */
  volume?: number;
  /** Per-clip playback rate (1 = normal). Reserved; not yet honored. */
  playbackRate?: number;
  /** Mirror flip (horizontal) for preview. Reserved; not yet honored. */
  mirrored?: boolean;
  // Color adjust (applied via AVMutableVideoComposition + CoreImage on iOS).
  // Each defaults to its neutral value when unset.
  brightness?: number; // -1..1
  contrast?: number; // 0..2
  saturation?: number; // 0..2
  warmth?: number; // -1..1
  shadows?: number; // -1..1
  highlights?: number; // -1..1
  // Chroma key
  chromaEnabled?: boolean;
  chromaColor?: string; // '#RRGGBB'
  chromaThreshold?: number; // 0..1
  // Person segmentation (Cutout). Native masks the frame so only the
  // segmented person remains; the rest becomes transparent.
  cutoutEnabled?: boolean;
};

/** Event payload helpers. timeUpdate fires on display-synced cadence
 *  (CADisplayLink/Choreographer). */
export type NleTimeUpdateEvent = {
  /** Composed timeline time in milliseconds. */
  ms: number;
  /** Index into the clips array that currently covers `ms`. */
  clipIndex: number;
  /** Clip id at that index. */
  clipId: string;
};

export type NlePlayingChangeEvent = { isPlaying: boolean };
export type NleStatusChangeEvent = {
  status: 'idle' | 'loading' | 'readyToPlay' | 'error';
  error?: string;
};
export type NlePlayToEndEvent = Record<string, never>;
/** Native-side error surface. Fired from NleEngine for caught errors
 *  (e.g. AVFoundation throws inside the CIFilter handler). Native
 *  uncaught NSExceptions are written directly to crash-log.jsonl by
 *  the module's OnCreate-installed exception handler — the JS-side
 *  initCrashLog reads that file on the next app launch. */
export type NleNativeErrorEvent = {
  source: string;
  message: string;
  detail?: string;
};

export type NlePlayerModuleEvents = {
  /** Fired roughly per frame while playing. Throttled when paused. */
  onTimeUpdate: (payload: NleTimeUpdateEvent) => void;
  onPlayingChange: (payload: NlePlayingChangeEvent) => void;
  onStatusChange: (payload: NleStatusChangeEvent) => void;
  onPlayToEnd: (payload: NlePlayToEndEvent) => void;
  onNativeError: (payload: NleNativeErrorEvent) => void;
};

export type NlePlayerViewProps = {
  /** Player instance handle. Returned from NlePlayer.create(). */
  playerHandle: number;
  style?: StyleProp<ViewStyle>;
};
