export type AudioPlaybackHandle = {
  pause(): void | Promise<void>;
};

let activePlayer: AudioPlaybackHandle | null = null;

function pausePlayer(player: AudioPlaybackHandle): void {
  try {
    const result = player.pause();
    if (result && typeof result.then === "function") void result.catch(() => {});
  } catch {
    // useAudioPlayer may have disposed the shared object during navigation.
  }
}

export function claimAudioPlayer(player: AudioPlaybackHandle): void {
  if (activePlayer && activePlayer !== player) pausePlayer(activePlayer);
  activePlayer = player;
}

export function stopActiveAudio(): void {
  if (activePlayer) pausePlayer(activePlayer);
  activePlayer = null;
}

/** The useAudioPlayer hook owns native disposal; this only forgets the global owner. */
export function releaseAudioPlayer(player: AudioPlaybackHandle): void {
  if (activePlayer === player) activePlayer = null;
}
