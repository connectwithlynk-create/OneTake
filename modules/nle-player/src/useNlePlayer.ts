import { useEffect, useRef } from 'react';

import { NlePlayer } from './NlePlayerModule';

/** React hook that owns the lifecycle of a single NlePlayer instance. */
export function useNlePlayer(): NlePlayer {
  const ref = useRef<NlePlayer | null>(null);
  if (!ref.current) ref.current = new NlePlayer();
  useEffect(() => {
    const p = ref.current!;
    return () => {
      try {
        p.destroy();
      } catch {
        /* ignore */
      }
    };
  }, []);
  return ref.current;
}
