import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { createRoot, type Root } from "test-renderer";
import ts from "typescript";

import { claimAudioPlayer, releaseAudioPlayer, stopActiveAudio, type AudioPlaybackHandle } from "../src/lib/audio-playback.ts";
import { GatewayApi } from "../src/gateway/api.ts";

type Player = AudioPlaybackHandle & { play(): void; seekTo(time: number): Promise<void>; playing: boolean; pauses: number };
const players = new Map<string, Player>();
const listeners = new Set<(state: string) => void>();
const Focus = React.createContext(true);
Object.assign(globalThis, {
  __audioReact: React, __audioFocus: Focus, __audioPlayers: players, __audioListeners: listeners,
  IS_REACT_ACT_ENVIRONMENT: true, __DEV__: false,
});
const hosts: Record<string, string> = {
  "expo-audio": `export function useAudioPlayer(source) {
    const id=source?.uri ?? 'none';
    let player=globalThis.__audioPlayers.get(id);
    if(!player) {
      player={playing:false,pauses:0,pause(){this.playing=false;this.pauses++;},
        play(){this.playing=true;},async seekTo(){}};
      globalThis.__audioPlayers.set(id,player);
    }
    return player;
  }
  export function useAudioPlayerStatus(player) {
    return {playing:player.playing,duration:10,currentTime:0,didJustFinish:false};
  }`,
  "expo-router": `export const router={push(){}};
    export const useIsFocused=()=>globalThis.__audioReact.useContext(globalThis.__audioFocus);`,
  "react-native": `export const View='View', Pressable='Pressable';
    export const AppState={addEventListener(_event,listener){
      globalThis.__audioListeners.add(listener);
      return {remove(){globalThis.__audioListeners.delete(listener);}};
    }};`,
  "@react-native-community/slider": `export default 'Slider';`,
  "lucide-react-native": `export const Pause='Pause', Play='Play';`,
  "@/components/file-type-icon.tsx": `export const FileTypeIcon='FileTypeIcon';`,
  "@/components/ui/icon.tsx": `export const Icon='Icon';`,
  "@/components/ui/text.tsx": `export const Text='Text';`,
  "@/components/chat/attachment-media.tsx": `export const useFilePreview=()=>({preview:{duration_ms:10000},failed:false});`,
  "@/lib/i18n.ts": `export const useTranslation=()=>({t:value=>value});`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: "audio-native.tsx", compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// Register native host replacements before importing the TSX component under test.
const { AudioCard } = await import("../src/components/chat/audio-native.tsx");
const api = new GatewayApi({ baseUrl: "http://audio", token: "test" });
after(() => api.close());
const card = (id: string, focused = true) => createElement(Focus.Provider, { value: focused },
  createElement(AudioCard, { file: { id, name: `${id}.mp3`, media_type: "audio/mpeg", size: 12 }, api }));
const play = async (root: Root, id: string) => {
  const button = root.container.queryAll(node => node.props.testID === `attachment-audio-${id}`)[0]
    .queryAll(node => node.type === "Pressable")[0];
  await act(async () => button.props.onPress());
  return players.get(api.fileContentUrl(id))!;
};

test("AudioCard pauses and releases its player when its Stack page blurs but stays mounted", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(card("blur")));
    const audio = await play(root, "blur");
    assert.equal(audio.playing, true);
    await act(async () => root.render(card("blur", false)));
    assert.equal(audio.pauses, 1, "a still-mounted blurred page must pause its audio");
    assert.equal(audio.playing, false);
    const next = { pause() { audio.pauses++; } };
    claimAudioPlayer(next);
    assert.equal(audio.pauses, 1, "blur must release the prior ownership");
    releaseAudioPlayer(next);
  } finally { await act(async () => root.unmount()); stopActiveAudio(); }
});

test("AudioCard pauses and releases playback when the app backgrounds", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(card("background")));
    const audio = await play(root, "background");
    assert.equal(listeners.size, 1);
    for (const listener of listeners) listener("background");
    assert.equal(audio.pauses, 1);
    assert.equal(audio.playing, false);
    const next = { pause() { audio.pauses++; } };
    claimAudioPlayer(next);
    assert.equal(audio.pauses, 1, "background must clear the owner");
    releaseAudioPlayer(next);
  } finally { await act(async () => root.unmount()); stopActiveAudio(); }
});

test("older AudioCard blur and unmount cannot pause or release the new page's player", async () => {
  const root = createRoot();
  const pages = (oldFocused: boolean, includeOld: boolean) => createElement(React.Fragment, null,
    includeOld ? card("old", oldFocused) : null, card("new"));
  try {
    await act(async () => root.render(pages(true, true)));
    const old = await play(root, "old");
    const current = await play(root, "new");
    assert.equal(old.pauses, 1, "claiming the new player pauses the old one");
    await act(async () => root.render(pages(false, true)));
    assert.equal(old.pauses, 1);
    assert.equal(current.pauses, 0);
    assert.equal(current.playing, true);
    await act(async () => root.render(pages(false, false)));
    assert.equal(current.pauses, 0);
    stopActiveAudio();
    assert.equal(current.pauses, 1, "old-page cleanup must not clear the new owner");
  } finally { await act(async () => root.unmount()); stopActiveAudio(); }
});

function player() {
  const state = { paused: 0 };
  return { state, handle: { pause: () => { state.paused++; } } satisfies AudioPlaybackHandle };
}

test("claiming a new audio player pauses the previous one", () => {
  const first = player();
  const second = player();
  claimAudioPlayer(first.handle);
  claimAudioPlayer(second.handle);
  assert.equal(first.state.paused, 1);
  stopActiveAudio();
  assert.equal(second.state.paused, 1);
  releaseAudioPlayer(second.handle);
  assert.equal(second.state.paused, 1);
});

test("a released native player cannot crash the next ownership transition", async () => {
  const released = { handle: { pause: () => Promise.reject(new Error("released")) } satisfies AudioPlaybackHandle };
  const next = player();
  claimAudioPlayer(released.handle);
  claimAudioPlayer(next.handle);
  stopActiveAudio();
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
  assert.equal(next.state.paused, 1, "a disposed prior handle must not prevent the new owner from being stopped");
});
