import type { Pages } from '../browser/protocol.ts';

export type BrowserTransport = 'jpeg' | 'video';
export type VideoPhase = 'connecting' | 'joining' | 'playing' | 'switching' | 'reconnecting' | 'failed' | 'ended';
export type VideoSupportReason = 'player-unavailable' | 'environment-unsupported' | 'video-not-configured';
export type VideoFailureReason = 'publisher-not-installed' | 'publisher-start-timeout' | 'publisher-exited' | 'cdp-unreachable' | 'page-publish-timeout' | 'sfu-unreachable' | 'token-failed' | 'watch-limit' | 'page-unavailable' | 'join-timeout' | 'first-frame-timeout';
export type VideoReady = { t: 'video'; state: 'ready'; url: string; room: string; token: string; track: string; page: string; vp: number; expires_in_s: number; renew: boolean };
export type VideoMessage = VideoReady | { t: 'video'; state: 'reconnecting' } | { t: 'video_failed'; reason: VideoFailureReason; retryable: boolean };
export type VideoState = {
  transport: BrowserTransport; phase: VideoPhase; supportReason: VideoSupportReason | null;
  source: VideoReady | null; generation: number;
  gatewayReady: boolean; playerConnected: boolean;
  picture: { width: number; height: number } | null;
  reason: VideoFailureReason | null;
};
export const initialVideoState: VideoState = { transport: 'jpeg', phase: 'playing', supportReason: null,
  source: null, generation: 0, gatewayReady: false, playerConnected: false,
  picture: null, reason: null };
export type VideoEvent =
  | { type: 'hello'; transport: BrowserTransport; supportReason: VideoSupportReason | null }
  | { type: 'closed' }
  | { type: 'suspended' }
  | { type: 'pages' }
  | { type: 'ready'; value: VideoReady }
  | { type: 'reconnecting'; origin: 'gateway' | 'player' }
  | { type: 'connected' }
  | { type: 'frame'; generation: number; width: number; height: number }
  | { type: 'jpeg' }
  | { type: 'failed'; reason: VideoFailureReason }
  | { type: 'retry' }
  | { type: 'ended' };

export function videoRatioMatches(width: number, height: number, css: readonly [number, number]): boolean {
  return width > 0 && height > 0 && css[0] > 0 && css[1] > 0 && Math.abs(width / height / (css[0] / css[1]) - 1) <= 0.01;
}
/** BrowserRuntime owns this lifecycle; pages remain the stream's external facts, not a copy. */
export function browserVideoReducer(state: VideoState, event: VideoEvent, pages: Pages | null): VideoState {
  if (state.phase === 'ended') return state;
  if (event.type === 'ended') return { ...initialVideoState, phase: 'ended', generation: state.generation + 1 };
  if (event.type === 'hello') return { ...initialVideoState, generation: state.generation + 1,
    source: state.picture ? state.source : null, picture: state.picture,
    supportReason: event.supportReason, transport: event.transport, phase: event.transport === 'video' ? 'connecting' : 'playing' };
  if (event.type === 'suspended') return { ...state, gatewayReady: false, playerConnected: false, generation: state.generation + 1 };
  if (event.type === 'closed') return { ...state,
    gatewayReady: false, playerConnected: false, source: null, picture: null,
    phase: state.transport === 'video' ? 'connecting' : 'playing', generation: state.generation + 1 };
  if (state.transport === 'jpeg') {
    return event.type === 'jpeg' && (state.phase !== 'playing' || state.source || state.picture)
      ? { ...state, phase: 'playing', source: null, picture: null } : state;
  }
  switch (state.phase) {
    case 'failed':
      return event.type === 'retry' ? { ...state, phase: 'connecting', reason: null, source: null, picture: null,
        gatewayReady: false, playerConnected: false, generation: state.generation + 1 } : state;
    case 'connecting':
    case 'joining':
    case 'playing':
    case 'switching':
    case 'reconnecting': {
      if (event.type === 'failed') return { ...state, phase: 'failed', reason: event.reason, source: null, picture: null,
        gatewayReady: false, playerConnected: false, generation: state.generation + 1 };
      if (event.type === 'pages') return pages?.current == null
        ? { ...state, phase: 'connecting', source: null, picture: null, gatewayReady: false, generation: state.generation + 1 }
        : { ...state, phase: 'switching', generation: state.generation + 1 };
      if (event.type === 'reconnecting') return { ...state, phase: 'reconnecting', generation: state.generation + 1,
        ...(event.origin === 'gateway' ? { gatewayReady: false } : { playerConnected: false }) };
      if (event.type === 'connected') return { ...state, playerConnected: true };
      if (event.type === 'ready') {
        const value = event.value;
        if (!pages || value.vp !== pages.vp || value.page !== pages.current) return state;
        if (value.renew) return state.source?.track === value.track && state.source.room === value.room ? { ...state, source: value } : state;
        const sameSource = state.gatewayReady && state.source?.room === value.room && state.source.url === value.url
          && state.source.track === value.track && state.source.page === value.page && state.source.vp === value.vp;
        return { ...state, source: value, gatewayReady: true,
          phase: state.phase === 'reconnecting' || sameSource ? state.phase : 'joining',
          generation: state.generation + (sameSource ? 0 : 1) };
      }
      if (event.type === 'frame') {
        if (event.generation !== state.generation || !state.source || !pages || state.source.page !== pages.current) return state;
        const picture = { width: event.width, height: event.height };
        const ready = state.gatewayReady && state.playerConnected && videoRatioMatches(event.width, event.height, pages.css);
        if (ready && state.phase === 'playing' && state.picture?.width === event.width && state.picture.height === event.height) return state;
        return { ...state, picture, phase: ready ? 'playing' : state.phase === 'reconnecting' ? 'reconnecting' : 'switching' };
      }
      return state;
    }
  }
}

export function videoInputReady(state: VideoState, pages: Pages | null): boolean {
  return state.transport === 'video' && state.phase === 'playing' && state.gatewayReady && state.playerConnected
    && pages?.current != null && state.source?.page === pages.current && !!state.picture
    && videoRatioMatches(state.picture.width, state.picture.height, pages.css);
}
