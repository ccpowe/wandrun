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

/** Pause and forget only this owner; a departing page cannot stop a newer player's audio.
 * Native disposal still belongs to useAudioPlayer. */
export function releaseAudioPlayer(player: AudioPlaybackHandle): void {
  if (activePlayer === player) stopActiveAudio();
}
