/* eslint-disable @typescript-eslint/no-unused-vars */
import { NleClip } from './NlePlayer.types';

/** Web stub: the native composition engine isn't implemented on web yet.
 *  Methods are no-ops; events never fire. Keeps imports from crashing
 *  when someone runs `expo start --web`. */
export class NlePlayer {
  private _handle = -1;
  get handle() {
    return this._handle;
  }
  setClips(_clips: NleClip[]) {}
  play() {}
  pause() {}
  seek(_ms: number) {}
  setClipVolume(_id: string, _v: number) {}
  get currentTime() {
    return 0;
  }
  get duration() {
    return 0;
  }
  get isPlaying() {
    return false;
  }
  addListener() {
    return { remove() {} };
  }
  destroy() {}
}

export default { create: () => -1 };
