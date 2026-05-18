import { useCallback, useEffect, useState } from 'react';
import { useSyncExternalStore } from 'react';

/**
 * Tiny reactive layer over the repo. Any mutation calls invalidate(); hooks
 * built on useData re-run their loader when the version bumps. Avoids pulling
 * in a full query library for an MVP.
 */
let version = 0;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot() {
  return version;
}

export function invalidate() {
  version++;
  listeners.forEach((l) => l());
}

export function useDataVersion() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface DataState<T> {
  data: T | undefined;
  loading: boolean;
  reload: () => void;
}

export function useData<T>(
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown> = []
): DataState<T> {
  const v = useDataVersion();
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);

  const run = useCallback(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const cancel = run();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, v]);

  return { data, loading, reload: () => invalidate() };
}
