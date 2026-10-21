import type { FileRecord, SearchResult } from "../gateway/api.ts";
import { assertNotAborted } from "./abort.ts";
import { UserFacingError } from "./user-error.ts";

/** Only passive image formats and ordinary text are rendered inside the app. */
export function previewKind(file: Pick<FileRecord, "media_type">): "image" | "text" | "other" {
  const type = file.media_type.split(";", 1)[0].trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"].includes(type)) return "image";
  if (type === "text/plain" || type === "text/markdown" || type === "text/csv" || type === "application/json") return "text";
  return "other";
}

export const TEXT_PREVIEW_BYTES = 1024 * 1024;
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
  "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md",
  "text/csv": ".csv", "application/json": ".json",
};
// Disjoint namespace: a legitimate original can itself end in `.keep`.
const MARKER_PREFIX = "keep-";


// A cache basename must fit Android's 255-byte component limit even for a 1 GiB
// original with a long Unicode name. The UI and share dialog keep the real name.
let cacheSequence = 0;
export function cacheName(file: Pick<FileRecord, "name" | "media_type">): string {
  const suffix = /\.([a-zA-Z0-9]{1,10})$/.exec(file.name)?.[0].toLowerCase()
    ?? EXTENSION_BY_MIME[file.media_type.split(";", 1)[0].trim().toLowerCase()] ?? "";
  return `wdf-${Date.now().toString(36)}-${(++cacheSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}${suffix}`;
}

type CacheFile = {
  readonly uri: string;
  readonly name: string;
  readonly exists: boolean;
  readonly modificationTime: number | null;
  create(): void;
  write(content: string): void;
  delete(): void;
  text(): Promise<string>;
};

type CacheStorage = {
  create(): void;
  list(): CacheFile[];
  file(name: string): CacheFile;
  download(url: string, destination: CacheFile, headers: Record<string, string>): Promise<unknown>;
};

export type CachedDownload = {
  readonly file: CacheFile;
  /** Retains the URI after the native sheet settles, even on cancel/throw. */
  share(handOff: (uri: string) => Promise<void>): Promise<void>;
  /** Idempotent; release an unshared preview on unmount or after reading text. */
  release(): void;
};

/**
 * Owns only the private delivery directory. A keep- marker distinguishes a
 * handed-off share from an interrupted download after process death. Previews
 * and partial downloads are removed at release (or on the next visit after a
 * crash). Shared originals are never reused by id: the server serves mutable
 * originals, so every action downloads the current bytes.
 * Logical cancellation discards the result after download settles; the native
 * transfer is never cancelled, since SDK 57 Android cancellation can leave it pending.
 *
 * Completed shares have a one-hour read lease, starting when the share sheet
 * closes. They are pruned on the next visit/download after expiry, not during
 * the lease: a receiver may still be asynchronously reading. There is no hard
 * byte cap (one valid original can be 1 GiB); disk use is bounded by shares
 * made within the last hour, and the OS may clear its cache sooner.
 */
export class DeliveryCache {
  private readonly active = new Set<string>();
  private readonly lifetimeMs = 60 * 60 * 1000;
  private readonly storage: CacheStorage;
  private readonly now: () => number;

  constructor(storage: CacheStorage, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
  }

  prune(): void {
    this.storage.create();
    const entries = this.storage.list();
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const entry of entries) {
      if (!entry.name.startsWith(MARKER_PREFIX)) continue;
      if (!byName.has(entry.name.slice(MARKER_PREFIX.length))) {
        if (!this.active.has(entry.uri)) entry.delete();
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith(MARKER_PREFIX) || this.active.has(entry.uri)) continue;
      const marker = byName.get(`${MARKER_PREFIX}${entry.name}`);
      if (!marker) {
        entry.delete();
      } else {
        if (this.now() - (marker.modificationTime ?? 0) >= this.lifetimeMs) {
          entry.delete();
          marker.delete();
        }
      }
    }
  }

  async download(url: string, file: Pick<FileRecord, "name" | "media_type">, headers: Record<string, string>, signal: AbortSignal): Promise<CachedDownload> {
    assertNotAborted(signal);
    this.prune();
    const destination = this.storage.file(cacheName(file));
    this.active.add(destination.uri); // Android can write a partial target before rejecting.
    try {
      await this.storage.download(url, destination, headers);
      assertNotAborted(signal);
    } catch (cause) {
      try {
        if (destination.exists) destination.delete();
      } finally {
        this.active.delete(destination.uri);
      }
      throw cause;
    }
    let released = false;
    let marker: CacheFile | null = null;
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (marker) {
          // Reset the retention window when the share sheet closes.
          marker.write("");
        } else if (destination.exists) destination.delete();
      } finally {
        this.active.delete(destination.uri);
      }
      if (marker) this.prune();
    };
    return {
      file: destination,
      share: async (handOff) => {
        try {
          if (released) throw new UserFacingError("文件暂不可分享，请重新打开文件后重试");
          const pending = this.storage.file(`${MARKER_PREFIX}${destination.name}`);
          pending.create();
          marker = pending;
          await handOff(destination.uri);
        } finally {
          release();
        }
      },
      release,
    };
  }
}

export function searchDestination(result: SearchResult):
  | { pathname: "/agents/[id]"; params: { id: string } }
  | { pathname: "/c/[id]"; params: { id: string; message_seq?: string } }
  | { pathname: "/files/[id]"; params: { id: string } } {
  switch (result.kind) {
    case "agent": return { pathname: "/agents/[id]", params: { id: result.id } };
    case "conversation": return { pathname: "/c/[id]", params: { id: result.id } };
    case "message": return { pathname: "/c/[id]", params: { id: result.task_id ?? result.conversation_id, message_seq: String(result.seq) } };
    case "file": return { pathname: "/files/[id]", params: { id: result.id } };
  }
}
