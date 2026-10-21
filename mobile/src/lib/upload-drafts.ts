import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as tus from "tus-js-client";

import type { GatewayApi } from "../gateway/api.ts";
import { UPLOAD_CHUNK_BYTES, boundedReadRange, latestDraft, mimeForFile, restoreDraft, type UploadDraft, type UploadItem, uploadMetadata } from "./upload-draft-state.ts";
import { assertUploadEndpoint, assertUploadLocation, isUnauthorizedUpload, LocalUploadError, uploadErrorMessage } from "./upload-error.ts";

export type PickedUpload = { uri: string; name: string; mimeType?: string | null; size?: number };

const controllers = new Map<string, UploadDraftController>();
const pendingStops = new Map<string, Set<Promise<void>>>();

function draftDirectory(computerId: string, conversationId: string, rootId = conversationId): Directory {
  const root = new Directory(Paths.document, "upload-drafts", encodeURIComponent(computerId), encodeURIComponent(rootId));
  return rootId === conversationId ? root : new Directory(root, "tasks", encodeURIComponent(conversationId));
}


/** SDK 57 File.slice calls bytesSync() on the WHOLE file; never let tus use that default reader.
 * FileHandle seeks and reads at most one bounded PATCH's bytes, then RN's XHR handles the Uint8Array body.
 */
export const boundedFileReader: NonNullable<ConstructorParameters<typeof tus.Upload>[1]["fileReader"]> = {
  async openFile(input: File) {
    let size: number;
    try { size = input.size; }
    catch (error) { throw new LocalUploadError("file", error); }
    return {
      size,
      async slice(start: number, end: number) {
        const { count, done } = boundedReadRange(size, start, end);
        if (count === 0) return { value: null, done };
        try {
          const handle = input.open(FileMode.ReadOnly);
          try {
            handle.offset = start;
            const value = handle.readBytes(count);
            if (value.byteLength !== count) throw new Error("本地文件读取不完整，请重试");
            // tus validates the final chunk with Blob-style size; RN still receives the
            // same ArrayBufferView and converts only these bytes for its XHR bridge.
            return { value: Object.assign(value, { size: value.byteLength }), done };
          } finally {
            handle.close();
          }
        } catch (error) { throw new LocalUploadError("file", error); }
      },
      close() { /* Each slice owns and closes its handle, including aborted uploads. */ },
    };
  },
};

/** Shared by mounted screens of one computer and conversation. Durable snapshots and
 * staged bytes live under that local computer identity, not a gateway URL or server id.
 * Subscribers observe one controller; its transfers belong to the API captured at acquisition.
 */
export class UploadDraftController {
  readonly directory: Directory;
  readonly conversationId: string;
  readonly rootId: string;
  readonly computerId: string;
  private readonly api: GatewayApi;
  private readonly connectionUrl: URL;
  draft: UploadDraft = { text: "", items: [] };
  error: string | null = null;
  ready = false;
  private disposed = false;
  private stopping: Promise<void> | null = null;
  private generation = 0;
  private readonly uploads = new Map<string, tus.Upload>();
  private readonly removedStops = new Set<Promise<void>>();
  private readonly terminationRequests = new Set<tus.HttpRequest>();
  private readonly pendingCopies = new Map<string, UploadItem>();
  private readonly subscribers = new Set<(controller: UploadDraftController) => void>();
  private readonly onApiClosed = () => { void this.suspend().catch(() => {}); };

  get items(): UploadItem[] {
    return [...this.draft.items, ...this.pendingCopies.values()];
  }

  constructor(api: GatewayApi, conversationId: string, rootId = conversationId) {
    const computerId = api.config.computerId;
    if (!computerId || api.signal.aborted) throw new Error("上传需要有效的电脑连接");
    this.api = api;
    this.connectionUrl = new URL(api.config.baseUrl);
    this.conversationId = conversationId;
    this.rootId = rootId;
    this.computerId = computerId;
    this.directory = draftDirectory(computerId, conversationId, rootId);
    api.signal.addEventListener("abort", this.onApiClosed, { once: true });
  }
  subscribe(changed: (controller: UploadDraftController) => void): () => void {
    this.subscribers.add(changed);
    if (this.ready || this.error) changed(this);
    return () => {
      this.subscribers.delete(changed);
      if (!this.subscribers.size) this.dispose();
    };
  }
  private changed(): void {
    for (const listener of this.subscribers) listener(this);
  }
  initialize(): void {
    try {
      const snapshots = ["draft-a.json", "draft-b.json"].map((name) => {
        const file = new File(this.directory, name);
        if (!file.exists) return null;
        try { return file.textSync(); } catch { return "invalid"; }
      });
      const saved = latestDraft(snapshots);
      this.generation = saved.generation;
      this.draft = restoreDraft(saved.draft);
      this.ready = true;
      this.changed();
      for (const item of this.draft.items) {
        if (!item.fileId && !item.error) { this.retry(item.id); break; }
      }
    } catch (error) {
      this.error = uploadErrorMessage(error, "draft-read");
      this.changed();
    }
  }

  private persist(): void {
    this.directory.create({ intermediates: true, idempotent: true });
    const next = this.generation + 1;
    const temp = new File(this.directory, "draft.tmp");
    temp.write(JSON.stringify({ generation: next, draft: this.draft }));
    // SDK 57 iOS overwrite unlinks destination before moving. The OTHER slot always
    // remains a recoverable committed snapshot until this move has succeeded.
    temp.moveSync(new File(this.directory, next % 2 ? "draft-a.json" : "draft-b.json"), { overwrite: true });
    this.generation = next;
  }

  private commit(next: UploadDraft): void {
    const previous = this.draft;
    this.draft = next;
    try { this.persist(); }
    catch (error) { this.draft = previous; throw new LocalUploadError("draft-write", error); }
    this.changed();
  }

  private update(id: string, fields: Partial<UploadItem>): void {
    if (this.disposed || !this.draft.items.some((item) => item.id === id)) return;
    this.commit({ ...this.draft, items: this.draft.items.map((item) => item.id === id ? { ...item, ...fields } : item) });
  }

  setText(text: string): void {
    if (!this.ready || this.disposed || this.error) return;
    try { this.commit({ ...this.draft, text }); }
    catch (error) { this.error = uploadErrorMessage(error); this.changed(); }
  }

  async add(picked: PickedUpload): Promise<void> {
    if (!this.ready || this.disposed || this.error) return;
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const source = new File(picked.uri);
    const item: UploadItem = {
      id: key, name: picked.name, mediaType: mimeForFile(picked.name, picked.mimeType),
      size: picked.size ?? 0, uploadUrl: null, fileId: null, progress: 0, error: null,
    };
    this.pendingCopies.set(key, item);
    this.changed();
    const destination = new File(this.directory, `${key}.bin`);
    try {
      this.directory.create({ intermediates: true, idempotent: true });
      await source.copy(destination);
      if (this.disposed || !this.pendingCopies.has(key)) {
        if (destination.exists) destination.delete();
        return;
      }
      if (!destination.exists) throw new Error("本地附件不可读取");
      item.size = destination.size;
      this.pendingCopies.delete(key);
      this.commit({ ...this.draft, items: [...this.draft.items, item] }); // Durable copy and manifest before POST.
      this.retry(key);
    } catch (error) {
      if (destination.exists) destination.delete();
      if (!this.disposed) throw error instanceof LocalUploadError ? error : new LocalUploadError("file", error);
    } finally {
      this.pendingCopies.delete(key);
      if (!this.disposed) this.changed();
    }
  }

  private pump(): void {
    if (this.disposed || this.error || this.uploads.size) return;
    const next = this.draft.items.find((item) => !item.fileId && !item.error);
    if (next) this.retry(next.id);
  }

  retry(id: string): void {
    const item = this.draft.items.find((entry) => entry.id === id);
    if (!item || item.fileId || this.uploads.has(id) || this.disposed) return;
    const file = new File(this.directory, `${id}.bin`);
    try {
      if (!file.exists || file.size !== item.size) throw new Error("Local attachment missing or changed");
    } catch (error) {
      this.fail(id, new LocalUploadError("file", error));
      this.pump();
      return;
    }
    let resumeUrl = item.uploadUrl;
    try {
      if (resumeUrl) assertUploadEndpoint(resumeUrl, this.connectionUrl);
    } catch {
      // A saved URL is untrusted; keep staged bytes and create a fresh upload instead.
      resumeUrl = null;
    }
    try { this.update(id, { error: null, uploadUrl: resumeUrl }); }
    catch (error) { this.error = uploadErrorMessage(error); this.changed(); return; }
    if (this.uploads.size) return; // One bounded 5 MiB XHR body at a time.
    const httpStack: tus.HttpStack = {
      getName: () => tus.defaultOptions.httpStack.getName(),
      createRequest: (method, target) => {
        assertUploadEndpoint(target, this.connectionUrl);
        return tus.defaultOptions.httpStack.createRequest(method, target);
      },
    };
    const upload = new tus.Upload(file, {
      endpoint: `${this.api.config.baseUrl}/uploads`,
      uploadUrl: resumeUrl,
      chunkSize: UPLOAD_CHUNK_BYTES,
      fileReader: boundedFileReader,
      storeFingerprintForResuming: false,
      retryDelays: null,
      metadata: uploadMetadata(this.conversationId, item),
      headers: this.api.headers(),
      httpStack,
      onUploadUrlAvailable: () => {
        // tus ignores a returned Promise here. Synchronous durable persistence ensures a crash
        // after POST cannot result in an unresumable PATCH issued by this process.
        if (this.uploads.get(id) === upload && !this.disposed && !this.api.signal.aborted && upload.url) {
          assertUploadEndpoint(upload.url, this.connectionUrl);
          this.update(id, { uploadUrl: upload.url });
        }
      },
      onBeforeRequest: (req) => {
        if (this.uploads.get(id) === upload && !this.disposed && !this.api.signal.aborted &&
          req.getMethod() === "PATCH" && upload.url) this.update(id, { uploadUrl: upload.url });
      },
      onAfterResponse: (req, res) => {
        if (req.getMethod() !== "POST" || res.getStatus() < 200 || res.getStatus() >= 300) return;
        const location = res.getHeader("Location");
        if (location != null) assertUploadLocation(location, req.getURL(), this.connectionUrl);
      },
      onProgress: (sent) => {
        if (this.uploads.get(id) !== upload || this.disposed || this.api.signal.aborted) return;
        const current = this.draft.items.find((entry) => entry.id === id);
        if (current && !current.fileId) {
          // Progress is transient: don't rewrite the manifest on every XHR progress callback.
          current.progress = sent;
          this.changed();
        }
      },
      onSuccess: ({ lastResponse }) => {
        if (this.uploads.get(id) !== upload || this.disposed || this.api.signal.aborted) return;
        this.uploads.delete(id);
        const fileId = lastResponse.getHeader("Upload-File-Id");
        try {
          if (!fileId) throw new Error("网关未返回文件 ID，请重试以查询上传结果");
          this.update(id, { fileId, progress: item.size, error: null, uploadUrl: upload.url });
        } catch (error) { this.fail(id, error); }
        this.pump();
      },
      onError: (error) => {
        if (this.uploads.get(id) !== upload || this.disposed || this.api.signal.aborted) return;
        this.uploads.delete(id);
        if (isUnauthorizedUpload(error)) this.api.handleUnauthorized();
        this.fail(id, error);
        this.pump();
      },
    });
    this.uploads.set(id, upload);
    upload.start();
  }

  private fail(id: string, error: unknown): void {
    if (this.disposed || !this.draft.items.some((entry) => entry.id === id)) return;
    const message = uploadErrorMessage(error);
    try { this.update(id, { error: message }); }
    catch (persistError) { this.error = uploadErrorMessage(persistError); this.changed(); }
  }

  /** A DELETE is best-effort: keep its request so a computer switch can cancel
   * the local transport without waiting for a server response. Unconfirmed
   * incomplete uploads expire on the gateway after 24 hours.
   */
  private terminate(url: string): void {
    try { assertUploadEndpoint(url, this.connectionUrl); }
    catch { return; } // Removing a draft must never contact an untrusted saved URL.
    const stack: tus.HttpStack = {
      getName: () => tus.defaultOptions.httpStack.getName(),
      createRequest: (method, target) => {
        assertUploadEndpoint(target, this.connectionUrl);
        const request = tus.defaultOptions.httpStack.createRequest(method, target);
        let cancelled = false;
        const tracked: tus.HttpRequest = {
          getMethod: () => request.getMethod(),
          getURL: () => request.getURL(),
          setHeader: (name, value) => request.setHeader(name, value),
          getHeader: (name) => request.getHeader(name),
          setProgressHandler: (handler) => request.setProgressHandler(handler),
          getUnderlyingObject: () => request.getUnderlyingObject(),
          send: (body) => {
            // tus awaits onBeforeRequest even when it returns void. A switch can
            // therefore cancel this request before tus reaches send().
            if (cancelled || this.disposed) return Promise.reject(new Error("Upload termination cancelled"));
            return request.send(body).finally(() => this.terminationRequests.delete(tracked));
          },
          abort: () => {
            cancelled = true;
            return request.abort();
          },
        };
        this.terminationRequests.add(tracked);
        return tracked;
      },
    };
    void tus.Upload.terminate(url, { headers: this.api.headers(), retryDelays: null, httpStack: stack })
      .catch((error: unknown) => {
        if (!this.disposed && !this.api.signal.aborted && isUnauthorizedUpload(error)) this.api.handleUnauthorized();
      });
  }

  remove(id: string): void {
    if (this.pendingCopies.delete(id)) {
      this.changed(); // The in-flight native copy removes its own destination on completion.
      return;
    }
    const item = this.draft.items.find((entry) => entry.id === id);
    if (!item) return;
    const upload = this.uploads.get(id);
    this.commit({ ...this.draft, items: this.draft.items.filter((entry) => entry.id !== id) });
    this.uploads.delete(id);
    if (upload) {
      const stopped = upload.abort();
      this.removedStops.add(stopped);
      // Keep failed local aborts in the handoff barrier instead of treating
      // a rejected Promise as a confirmed stop.
      void stopped.then(() => this.removedStops.delete(stopped), () => {});
    }
    const url = upload?.url ?? item.uploadUrl;
    if (!item.fileId && url) this.terminate(url);
    const file = new File(this.directory, `${id}.bin`);
    if (file.exists) file.delete();
    this.pump();
  }

  /** The send command has captured the immutable attachment IDs; no retry needs staged bytes. */
  consume(): { text: string; files: { id: string; name: string; media_type: string; size: number }[] } | null {
    if (this.disposed || this.pendingCopies.size || this.error || !this.ready || this.draft.items.some((item) => !item.fileId || item.error)) return null;
    const { text, items } = this.draft;
    if (!text.trim() && !items.length) return null;
    this.commit({ text: "", items: [] });
    for (const item of items) {
      // The server copy is already durable; a failed local deletion must not prevent send.
      try {
        const file = new File(this.directory, `${item.id}.bin`);
        if (file.exists) file.delete();
      } catch (error) {
        console.warn("Could not remove staged attachment", error);
      }
    }
    return { text: text.trim(), files: items.map((item) => ({ id: item.fileId!, name: item.name, media_type: item.mediaType, size: item.size })) };
  }

  /** Stop this API's transfers without deleting durable snapshots or staged bytes. */
  suspend(): Promise<void> {
    if (this.disposed) return this.stopping ?? Promise.resolve();
    this.disposed = true;
    this.api.signal.removeEventListener("abort", this.onApiClosed);
    if (controllers.get(this.directory.uri) === this) controllers.delete(this.directory.uri);
    const stopping = [...this.uploads.values()].map((upload) => upload.abort());
    this.uploads.clear();
    this.subscribers.clear();
    const deleting = [...this.terminationRequests].map((request) => request.abort());
    this.terminationRequests.clear();
    // Only local aborts belong to the handoff barrier; DELETE may never receive
    // a response, and cancellation cannot confirm remote deletion.
    const pending = Promise.all([...stopping, ...this.removedStops, ...deleting]).then(() => {});
    this.stopping = pending;
    if (stopping.length || this.removedStops.size || deleting.length) {
      let set = pendingStops.get(this.computerId);
      if (!set) pendingStops.set(this.computerId, set = new Set());
      set.add(pending);
      // A failed abort is a failed handoff, not a completed stop. Retain it so
      // the session barrier cannot silently start another computer afterward.
      void pending.then(() => {
        set.delete(pending);
        if (!set.size) pendingStops.delete(this.computerId);
      }, () => {});
    }
    return pending;
  }

  dispose(): void {
    void this.suspend().catch(() => {});
  }

  discard(): void {
    this.dispose();
    if (this.directory.exists) this.directory.delete();
  }
}

/** Each mounted screen owns a subscription, not a controller. The last release
 * suspends transfers; a future mount reloads the durable snapshot and resumes.
 */
export function acquireUploadDraft(api: GatewayApi, conversationId: string, changed: (controller: UploadDraftController) => void, rootId = conversationId): {
  controller: UploadDraftController; release(): void;
} {
  if (!api.config.computerId || api.signal.aborted) throw new Error("上传需要有效的电脑连接");
  const key = draftDirectory(api.config.computerId, conversationId, rootId).uri;
  let controller = controllers.get(key);
  if (!controller) {
    controller = new UploadDraftController(api, conversationId, rootId);
    controllers.set(key, controller);
  }
  const unsubscribe = controller.subscribe(changed);
  if (!controller.ready && !controller.error) controller.initialize();
  let released = false;
  return {
    controller,
    release() {
      if (released) return;
      released = true;
      unsubscribe();
    },
  };
}

/** Pause uploads before closing the old API. The next acquisition reloads its durable draft. */
export async function suspendComputerUploads(computerId: string): Promise<void> {
  const current = [...controllers.values()].filter((controller) => controller.computerId === computerId)
    .map((controller) => controller.suspend());
  await Promise.all([...current, ...(pendingStops.get(computerId) ?? [])]);
}

/** Called for local/remote conversation.deleted, even when its chat screen is not mounted. */
export function discardConversationDraft(computerId: string, conversationId: string): void {
  for (const controller of [...controllers.values()]) {
    if (controller.computerId === computerId && (controller.rootId === conversationId || controller.conversationId === conversationId)) controller.discard();
  }
  const directory = draftDirectory(computerId, conversationId);
  if (directory.exists) directory.delete();
}

/** A fresh full conversation list catches deletions that happened while the app was not running. */
export function pruneConversationDrafts(computerId: string, existing: Set<string>): void {
  const root = new Directory(Paths.document, "upload-drafts", encodeURIComponent(computerId));
  if (!root.exists) return;
  for (const entry of root.list()) {
    if (entry instanceof Directory && !existing.has(decodeURIComponent(entry.name))) {
      discardConversationDraft(computerId, decodeURIComponent(entry.name));
    }
  }
}
