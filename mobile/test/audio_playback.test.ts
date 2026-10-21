import assert from "node:assert/strict";
import { test } from "node:test";

import { claimAudioPlayer, releaseAudioPlayer, stopActiveAudio, type AudioPlaybackHandle } from "../src/lib/audio-playback.ts";

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
  assert.doesNotThrow(() => claimAudioPlayer(next.handle));
  stopActiveAudio();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
