import { GatewayError, type FileDetail } from '../gateway/api.ts';

/** Missing originals outrank cached availability; transient failures retain the last complete snapshot. */
export function selectFileRead(data: FileDetail | undefined, error: unknown, paused: boolean) {
  const unavailable = error instanceof GatewayError && [404, 410].includes(error.status);
  const terminal = error instanceof GatewayError && [400, 401, 403, 404, 405, 410, 422].includes(error.status);
  return {
    file: unavailable ? undefined : data,
    loading: !data && !error,
    feedback: paused || !error ? null : terminal ? '文件暂不可用' : '无法读取文件信息，正在重试…',
    retrying: !paused && !!error && !terminal,
    stale: !!data && !unavailable,
  };
}
