import type { DetailedError } from "tus-js-client";

type LocalFailure = "file" | "draft-read" | "draft-write";
const localMessages: Record<LocalFailure, string> = {
  file: "无法读取所选文件",
  "draft-read": "无法读取附件草稿，请重试",
  "draft-write": "无法保存附件草稿，请重试",
};

/** Preserve the local failure boundary even when tus wraps it with request metadata. */
export class LocalUploadError extends Error {
  readonly kind: LocalFailure;
  constructor(kind: LocalFailure, cause: unknown) {
    super(localMessages[kind], { cause });
    this.kind = kind;
  }
}

const endpointMessage = "上传地址不安全，请检查电脑连接后重试";

/** Reject an upload URL before tus can attach a bearer header or open a transport. */
export class UploadEndpointError extends Error {
  constructor() {
    super(endpointMessage);
  }
}

export function assertUploadEndpoint(target: string, connection: URL): void {
  try {
    const url = new URL(target);
    if ((url.protocol === "http:" || url.protocol === "https:") &&
      url.protocol === connection.protocol && url.origin === connection.origin &&
      !url.username && !url.password) return;
  } catch {
    // Invalid and relative URLs are not upload targets.
  }
  throw new UploadEndpointError();
}

/** tus resolves Location against its POST endpoint; validate that exact result first. */
export function assertUploadLocation(location: string, endpoint: string, connection: URL): void {
  try {
    assertUploadEndpoint(new URL(location, endpoint).toString(), connection);
  } catch {
    throw new UploadEndpointError();
  }
}

export function isUploadEndpointError(error: unknown): boolean {
  return error instanceof UploadEndpointError ||
    (!!error && typeof error === "object" &&
      (error as Partial<DetailedError>).causingError instanceof UploadEndpointError);
}

/** tus errors may contain private request headers; inspect only the HTTP status. */
export function isUnauthorizedUpload(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as Partial<DetailedError>).originalResponse?.getStatus() === 401;
}

export function uploadErrorMessage(error: unknown, localFailure?: LocalFailure): string {
  if (error instanceof LocalUploadError) return localMessages[error.kind];
  if (isUploadEndpointError(error)) return endpointMessage;
  if (localFailure) return localMessages[localFailure];
  if (error && typeof error === "object") {
    const detail = error as Partial<DetailedError>;
    if (detail.causingError instanceof LocalUploadError) return localMessages[detail.causingError.kind];
    const status = detail.originalResponse?.getStatus();
    switch (status) {
      case 413: return "文件超过大小上限";
      case 507: return "电脑磁盘空间不足";
      case 404:
      case 410: return "上传已过期或不存在，需重新上传";
      case 401:
      case 403: return "上传未获授权，请检查电脑连接";
    }
    if (detail.originalRequest && (status === undefined || status === 0)) return "连不上电脑";
  }
  return "上传失败，请重试";
}

