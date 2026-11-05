import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";

/**
 * Capture a navigation screen's current uninterrupted focus visit, from an event handler
 * only (never during render). Capture while unfocused always yields a false predicate.
 * Expo Router 57 useFocusEffect ends the visit on blur or unmount; refocusing creates
 * a new identity. In-page sheets, Alerts, app backgrounding and rotation do not end it.
 */
export function useFocusedVisit(): () => () => boolean {
  const visit = useRef<object | null>(null);
  useFocusEffect(useCallback(() => {
    visit.current = {};
    // Blur and unmount both end this visit; focusing again creates a different identity.
    return () => { visit.current = null; };
  }, []));

  return useCallback(() => {
    const startedIn = visit.current;
    return () => startedIn !== null && visit.current === startedIn;
  }, []);
}

/**
 * design.md 提醒规则：a page's notice is scoped to this focus visit. `onEnd` runs when the visit ends
 * (blur, including a push to another route, or unmount), so a returning user starts a fresh visit.
 * `onEnd` must be stable (useCallback): a changed callback would end the visit early.
 */
export function useOnVisitEnd(onEnd: () => void): void {
  useFocusEffect(useCallback(() => onEnd, [onEnd]));
}

export type VisitNotice<T> = Readonly<{
  /** The one-time result shown to this visit, or null. */
  notice: T | null;
  /** Call when an operation starts: clears the previous result and returns this visit's publisher. */
  begin(): (value: T) => void;
  /** Close it now (the optional ×). */
  dismiss(): void;
}>;

/**
 * design.md 提醒规则 2 / 4：a one-time operation result belongs to the page visit that started the
 * operation. The publisher returned by `begin()` shows its value only while that same uninterrupted
 * focus visit is current, so a result that settles after a push away / unmount is dropped; ending the
 * visit (blur or unmount) clears whatever is shown. The operation itself is untouched: callers still
 * finish their own state (busy → idle, success applied) regardless of the visit.
 */
export function useVisitNotice<T = string>(): VisitNotice<T> {
  const captureVisit = useFocusedVisit();
  const [notice, setNotice] = useState<T | null>(null);
  useFocusEffect(useCallback(() => () => setNotice(null), []));
  const begin = useCallback(() => {
    setNotice(null);
    const stillHere = captureVisit();
    return (value: T) => { if (stillHere()) setNotice(() => value); };
  }, [captureVisit]);
  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, begin, dismiss };
}
