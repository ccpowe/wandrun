/** React Native's AbortSignal may not expose throwIfAborted despite supporting abort. */
export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('连接已关闭');
    error.name = 'AbortError';
    throw error;
  }
}
