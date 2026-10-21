import { AppState, Dimensions, Platform, type NativeEventSubscription, type View } from 'react-native';
import { intersectsRenderViewport } from '@/lib/render-budget.ts';

// One observer/timer for all blocks; callers stop observing unfocused routes.
const observed = new Map<View, (visible: boolean) => void>();
let webObserver: IntersectionObserver | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let appSubscription: NativeEventSubscription | undefined;
let generation = 0;

function measure() {
  const current = ++generation;
  const foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const viewport = Dimensions.get('window');
  for (const [view, notify] of observed) {
    if (!foreground) { notify(false); continue; }
    view.measureInWindow((x, y, width, height) => {
      if (generation === current && observed.get(view) === notify) {
        notify(intersectsRenderViewport(x, y, width, height, viewport.width, viewport.height));
      }
    });
  }
}

function webVisibilityChanged() {
  webObserver?.disconnect();
  for (const [view, notify] of observed) {
    notify(false);
    if (!document.hidden) webObserver?.observe(view as unknown as Element);
  }
}
/** Observe the actual block, not its containing message row (which may be huge). */

export function observeRenderVisibility(view: View, notify: (visible: boolean) => void): () => void {
  observed.set(view, notify);
  if (Platform.OS === 'web') {
    if (observed.size === 1) document.addEventListener('visibilitychange', webVisibilityChanged);
    webObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) observed.get(entry.target as unknown as View)?.(
        entry.isIntersecting && entry.boundingClientRect.width > 0 && entry.boundingClientRect.height > 0 && !document.hidden);
    });
    webObserver.observe(view as unknown as Element);
  } else {
    if (!timer) {
      timer = setInterval(measure, 250);
      appSubscription = AppState.addEventListener('change', measure);
    }
    // Coalesce mounts; measuring every earlier block on each mount is quadratic.
    if (observed.size === 1) measure();
  }
  return () => {
    observed.delete(view);
    webObserver?.unobserve(view as unknown as Element);
    if (!observed.size) {
      generation++;
      webObserver?.disconnect();
      webObserver = undefined;
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', webVisibilityChanged);
      clearInterval(timer);
      timer = undefined;
      appSubscription?.remove();
      appSubscription = undefined;
    }
  };
}
