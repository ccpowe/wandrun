import type { ComponentProps } from 'react';
import { useSyncExternalStore } from 'react';
import { NativeModules, Platform, UIManager } from 'react-native';
import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room } from 'livekit-client';
import type * as LiveKitNative from '@livekit/react-native';
import type { MediaStream as NativeMediaStream } from '@livekit/react-native-webrtc';
import type { VideoReady } from '../lib/browser-video.ts';

type NativeSdk = typeof LiveKitNative;
type ClientSdk = typeof import('livekit-client');
type TrackReference = NonNullable<ComponentProps<NativeSdk['VideoTrack']>['trackRef']>;
export type RenderedVideoFrame = { source: string; context: string; width: number; height: number; at_ms: number };
let sdk: { native: NativeSdk; client: ClientSdk } | null = null;

/** Do not import WebRTC at all in Expo Go / old binaries. iOS lacks this draw contract. */
export function browserVideoAvailable(): boolean {
  if (Platform.OS !== 'android' || !NativeModules.WebRTCModule || !NativeModules.LivekitReactNativeModule) return false;
  const config = UIManager.getViewManagerConfig('RTCVideoView') as unknown as {
    NativeProps?: Record<string, string>; directEventTypes?: Record<string, unknown>;
  } | null;
  return !!config?.NativeProps?.retainLastFrame && !!config?.directEventTypes?.onFrameRendered;
}
function nativeSdk() {
  if (!browserVideoAvailable()) return null;
  if (!sdk) {
    try {
      const native = require('@livekit/react-native') as NativeSdk;
      native.registerGlobals({ autoConfigureAudioSession: false });
      sdk = { native, client: require('livekit-client') as ClientSdk };
    } catch { return null; }
  }
  return sdk;
}

export type BrowserVideoSurfaceSnapshot = { trackRef: TrackReference | undefined; context: string };
export type VideoPlayerEvents = {
  connected(): void; reconnecting(): void; failed(): void;
  subscribed(source: VideoReady): void;
  rendered(frame: RenderedVideoFrame): void;
};
export interface BrowserVideoConnection {
  watch(source: VideoReady): void;
  stop(): void;
  setContext(context: string): void;
  subscribe(notify: () => void): () => void;
  getSnapshot(): BrowserVideoSurfaceSnapshot;
  onRendered(event: { nativeEvent: RenderedVideoFrame }): void;
}

/** One visible BrowserRuntime owns one receive-only Room, not a component effect chain.
 * The same official VideoTrack stays mounted through unpublish / republish. Native surface
 * retention handles the gap; this owner never takes screenshots or delays a source swap. */
export class BrowserVideoPlayer implements BrowserVideoConnection {
  private room: Room | null = null;
  private source: VideoReady | null = null;
  private snapshot: BrowserVideoSurfaceSnapshot = { trackRef: undefined, context: '' };
  private listeners = new Set<() => void>();
  constructor(private events: VideoPlayerEvents) {}
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  getSnapshot = () => this.snapshot;
  private publish(update: Partial<BrowserVideoSurfaceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const notify of this.listeners) notify();
  }
  setContext(context: string) { if (this.snapshot.context !== context) this.publish({ context }); }
  watch(source: VideoReady): void {
    const loaded = nativeSdk();
    if (!loaded) { this.events.failed(); return; }
    if (this.room && this.source?.room === source.room && this.source.url === source.url) {
      this.source = source;
      if (this.snapshot.trackRef?.publication.trackName !== source.track) this.publish({ trackRef: undefined });
      this.subscribeTrack(this.room);
      if (this.room.state === loaded.client.ConnectionState.Connected) this.events.connected();
      return;
    }
    this.stop();
    this.source = source;
    const { Room, RoomEvent } = loaded.client;
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;
    const current = () => this.room === room;
    room.on(RoomEvent.Connected, () => { if (current()) { this.subscribeTrack(room); this.events.connected(); } });
    room.on(RoomEvent.Reconnected, () => { if (current()) { this.subscribeTrack(room); this.events.connected(); } });
    room.on(RoomEvent.Reconnecting, () => { if (current()) this.events.reconnecting(); });
    room.on(RoomEvent.SignalReconnecting, () => { if (current()) this.events.reconnecting(); });
    room.on(RoomEvent.Disconnected, () => { if (current()) this.events.failed(); });
    room.on(RoomEvent.TrackPublished, () => { if (current()) this.subscribeTrack(room); });
    room.on(RoomEvent.TrackSubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (current() && publication.trackName === this.source?.track && publication.kind === 'video') {
        this.publish({ trackRef: { participant, publication, source: publication.source } });
        this.events.subscribed(this.source);
      }
      else publication.setSubscribed(false);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (current() && this.snapshot.trackRef?.publication === publication) {
        this.publish({ trackRef: undefined }); this.events.reconnecting();
      }
    });
    room.on(RoomEvent.TrackSubscriptionFailed, () => { if (current()) this.events.failed(); });
    // No microphone, camera, data messages, or audio subscriptions. Tokens also forbid publish.
    void room.connect(source.url, source.token, { autoSubscribe: false }).catch(() => { if (current()) this.events.failed(); });
  }
  private subscribeTrack(room: Room) {
    const source = this.source;
    if (!source) return;
    for (const participant of room.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) {
      const selected = publication.kind === 'video' && publication.trackName === source.track;
      publication.setSubscribed(selected);
      if (selected && publication.track) {
        this.publish({ trackRef: { participant, publication, source: publication.source } });
        this.events.subscribed(source);
      }
    }
  }
  onRendered = ({ nativeEvent }: { nativeEvent: RenderedVideoFrame }) => {
    const mediaStream = this.snapshot.trackRef?.publication.track?.mediaStream as unknown as NativeMediaStream | undefined;
    const source = mediaStream?.toURL();
    if (source && nativeEvent.source === source && nativeEvent.context === this.snapshot.context) this.events.rendered(nativeEvent);
  };
  stop(): void {
    const room = this.room;
    this.room = null; this.source = null;
    if (this.snapshot.trackRef) this.publish({ trackRef: undefined });
    if (room) { room.removeAllListeners(); void room.disconnect().catch(() => {}); }
  }
}

export function BrowserVideoSurface({ player, width, height }: { player: BrowserVideoConnection; width: number; height: number }) {
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const loaded = sdk;
  if (!loaded) return null;
  const VideoTrack = loaded.native.VideoTrack;
  return <VideoTrack trackRef={snapshot.trackRef} retainLastFrame frameContext={snapshot.context} onFrameRendered={player.onRendered}
    objectFit="contain" style={{ width, height }} />;
}
