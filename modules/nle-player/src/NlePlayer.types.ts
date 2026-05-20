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

export type NlePlayerModuleEvents = {
  /** Fired roughly per frame while playing. Throttled when paused. */
  onTimeUpdate: (payload: NleTimeUpdateEvent) => void;
  onPlayingChange: (payload: NlePlayingChangeEvent) => void;
  onStatusChange: (payload: NleStatusChangeEvent) => void;
  onPlayToEnd: (payload: NlePlayToEndEvent) => void;
};

export type NlePlayerViewProps = {
  /** Player instance handle. Returned from NlePlayer.create(). */
  playerHandle: number;
  style?: StyleProp<ViewStyle>;
};
