import { useLayoutEffect, type DependencyList, type EffectCallback } from 'react';

/**
 * Measure before paint and adjust layout from the measurement; return cleanup if needed.
 * Repeats when dependencies change. Not for mirroring state or writing latest-value refs;
 * use useEffectEvent for asynchronous callbacks that need fresh values instead.
 * Lint recognizes Effect Events and dependencies, but not synchronous setState in this callback.
 */
export function useMeasureLayout(measure: EffectCallback, dependencies: DependencyList): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Callers' dependencies are checked via additionalEffectHooks.
  useLayoutEffect(measure, dependencies);
}
