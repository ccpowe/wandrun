import { useLayoutEffect, useState } from "react";

// A separate factory scope is intentional: a cross-runtime reference must retain
// only this slot, not the hook's first callback or any component render environment.
function runtimeEntry<Args extends unknown[]>() {
  let current: ((...args: Args) => void) | null = null;
  return {
    invoke: (...args: Args) => { current?.(...args); },
    update: (next: typeof current) => { current = next; },
  };
}

/** A lifetime-stable RN entry for UI worklets. Dispatches to the latest committed
 * handler; queued UI calls after unmount are ignored and no old handler is retained.
 * Updating during layout (not render) also excludes abandoned React renders.
 */
export function useRuntimeCallback<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void {
  const [entry] = useState(runtimeEntry<Args>);
  useLayoutEffect(() => {
    entry.update(callback);
    return () => { entry.update(null); };
  }, [callback, entry]);
  return entry.invoke;
}
