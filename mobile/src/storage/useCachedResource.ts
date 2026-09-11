import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { readResource, writeResource } from './resourceCache';
import { logWarn } from '../appLogger';

/** Cache-first UI, with a scope/revision fence against late disk and network results. */
export default function useCachedResource<T>(scope: string, key: string, initial: T) {
  const initialRef = useRef(initial);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const revision = useRef(0);
  const [state, setState] = useState({ scope, value: initial, persist: false });
  const stateRef = useRef(state);
  const value = state.scope === scope ? state.value : initialRef.current;

  useEffect(() => {
    let cancelled = false;
    const started = revision.current;
    void readResource<T>(scope, key).then(cached => {
      if (!cached || cancelled || started !== revision.current) return;
      stateRef.current = { scope, value: cached.value, persist: false };
      setState(stateRef.current);
    }).catch(() => logWarn('[LocalCache] Failed to read cached resource'));
    return () => { cancelled = true; };
  }, [scope, key]);

  useEffect(() => {
    if (state.scope !== scope || !state.persist) return;
    void writeResource(scope, key, state.value)
      .catch(() => logWarn('[LocalCache] Failed to persist resource'));
  }, [scope, key, state]);

  const update = useCallback((next: SetStateAction<T>) => {
    if (scopeRef.current !== scope) return;
    const previous = stateRef.current;
    const held = previous.scope === scope ? previous.value : initialRef.current;
    const updated = typeof next === 'function' ? (next as (prev: T) => T)(held) : next;
    if (updated === held) return;
    revision.current += 1;
    stateRef.current = { scope, persist: true, value: updated };
    setState(stateRef.current);
  }, [scope]);

  return [value, update] as const;
}
