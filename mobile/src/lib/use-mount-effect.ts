import { useEffect } from 'react';

/**
 * Synchronize with an external system on mount; always return a cleanup function.
 * Setup and cleanup must be repeatable, including Strict Mode's setup-cleanup-setup cycle.
 * Captures mount-time values only: changing dependencies must remount the component via key.
 * Lint recognizes Effect Events here, but cannot flag synchronous setState in this custom callback.
 * Do not use it to mirror state; choose the alternatives in react-guidelines.md §3 instead.
 */
export function useMountEffect(setup: () => () => void): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Mount-only contract; changing inputs must remount via key.
  useEffect(setup, []);
}
