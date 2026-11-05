import { useLayoutEffect, useState } from 'react';

// A separate factory scope keeps a remote reference from retaining any render or frame.
function runtimeEntry<Args extends unknown[]>() {
  let current: ((...args: Args) => void) | null = null;
  return {
    invoke: (...args: Args) => { current?.(...args); },
    publish: (next: typeof current) => { current = next; },
  };
}

/** Publish only a committed callback to an external JS/UI runtime. This is not an effect
 * runner: no arbitrary setup/dependencies API, and invoking never happens during commit.
 * Layout cleanup revokes access on unmount AND Suspense hiding. Passive mount cleanup
 * and Effect Events cannot provide that boundary. Only browser runtime bridges use it.
 */
export function useRuntimeCommit<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void {
  const [entry] = useState(runtimeEntry<Args>);
  useLayoutEffect(() => {
    entry.publish(callback);
    return () => { entry.publish(null); };
  }, [callback, entry]);
  return entry.invoke;
}
