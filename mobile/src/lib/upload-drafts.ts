import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as tus from "tus-js-client";

import type { GatewayApi } from "../gateway/api.ts";
import { UPLOAD_CHUNK_BYTES, boundedReadRange, latestDraft, mimeForFile, restoreDraft, type UploadDraft, type UploadItem, uploadMetadata } from "./upload-draft-state.ts";
import { assertUploadEndpoint, assertUploadLocation, isUnauthorizedUpload, LocalUploadError, uploadErrorMessage } from "./upload-error.ts";
import type { NewChatAttempt } from "./new-conversation.ts";
import type { ChatSession } from "../gateway/session.ts";

export type PickedUpload = { uri: string; name: string; mimeType?: string | null; size?: number };

const controllers = new Map<string, UploadDraftController>();
const pendingStops = new Map<string, Set<Promise<void>>>();

function draftDirectory(computerId: string, conversationId: string, rootId = conversationId): Directory {
  const root = new Directory(Paths.document, "upload-drafts", encodeURIComponent(computerId), encodeURIComponent(rootId));
  return rootId === conversationId ? root : new Directory(root, "tasks", encodeURIComponent(conversationId));
}
function readDraft(directory: Directory): { generation: number; draft: UploadDraft } {
  return latestDraft(["draft-a.json", "draft-b.json"].map((name) => {
    const file = new File(directory, name);
    if (!file.exists) return null;
    try { return file.textSync(); } catch { return "invalid"; }
  }));
}

function writeDraft(directory: Directory, generation: number, draft: UploadDraft): number {
  directory.create({ intermediates: true, idempotent: true });
  const next = generation + 1;
  const temp = new File(directory, "draft.tmp");
  temp.write(JSON.stringify({ generation: next, draft }));
  // SDK 57 overwrite unlinks its destination; the other slot remains committed.
  temp.moveSync(new File(directory, next % 2 ? "draft-a.json" : "draft-b.json"), { overwrite: true });
  return next;
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
    return [
      ...this.draft.items.map((item) => item.mediaType.startsWith("image/")
        ? { ...item, previewUri: new File(this.directory, `${item.id}.bin`).uri }
        : item),
      ...this.pendingCopies.values(),
    ];
  }

  constructor(api: GatewayApi, conversationId: string, rootId = conversationId) {
    const computerId = api.config.computerId;
    if (!computerId || api.signal.aborted) throw new Error("上传需要有效的服务器连接");
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
      const saved = readDraft(this.directory);
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


  private commit(next: UploadDraft): void {
    const previous = this.draft;
    this.draft = next;
    try { this.generation = writeDraft(this.directory, this.generation, this.draft); }
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

  /** Persist first binding only; the real screen's normal acquisition starts uploads after navigation. */
  adoptNewConversation(attempt: NewChatAttempt): void {
    if (!this.ready || this.disposed || this.error) throw new Error("无法读取草稿");
    if (this.draft.adoptedFrom === attempt.clientId) return;
    if (this.draft.text || this.items.length || this.draft.firstSend) throw new Error("对话已有草稿，原草稿仍在");
    this.directory.create({ intermediates: true, idempotent: true });
    for (const item of attempt.files) {
      const destination = new File(this.directory, `${item.id}.bin`);
      if (!destination.exists) new File(item.uri).moveSync(destination);
      if (destination.size !== item.size) throw new Error("本地附件不可读取");
    }
    this.commit({ text: attempt.text, adoptedFrom: attempt.clientId, firstMessageId: attempt.messageClientId, items: attempt.files.map(item => ({
      id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
      uploadUrl: null, fileId: null, progress: 0, error: null,
    })) });
  }

  /** A retry keeps the unconsumed first intent until its following draft is durable too. */
  handoffNewConversation(attempt: NewChatAttempt, followingText?: string): {
    transferred: boolean;
    message: UploadDraft["firstSend"] | null;
  } {
    const fresh = this.draft.adoptedFrom !== attempt.clientId;
    this.adoptNewConversation(attempt);
    const unconsumed = this.draft.firstMessageId === attempt.messageClientId;
    const transferred = followingText !== undefined && (fresh || unconsumed);
    if (attempt.kind === "attachments") {
      if (transferred && this.draft.text !== followingText) this.commit({ ...this.draft, text: followingText });
      return { transferred, message: null };
    }
    const message = this.draft.firstSend ?? (unconsumed ? (() => {
      const consumed = this.consume(attempt.messageClientId, undefined, transferred ? followingText : "");
      if (!consumed) throw new Error("无法取出草稿");
      return { clientId: attempt.messageClientId, ...consumed };
    })() : null);
    return { transferred, message };
  }

  acknowledgeFirstSend(clientId: string): void {
    if (this.draft.firstSend?.clientId !== clientId) return;
    const { firstSend: _, ...rest } = this.draft;
    this.commit(rest);
  }


  /** The send command has captured the immutable attachment IDs; no retry needs staged bytes. */
  consume(firstClientId = this.draft.firstMessageId, messageText?: string, followingText = ""): { text: string; files: { id: string; name: string; media_type: string; size: number }[] } | null {
    if (this.disposed || this.pendingCopies.size || this.error || !this.ready || this.draft.items.some((item) => !item.fileId || item.error)) return null;
    const { items } = this.draft;
    const body = this.draft.text.trim();
    const text = messageText ?? body;
    if (!items.length && (!body || messageText !== undefined && !messageText.trim())) return null;
    const files = items.map(item => ({ id: item.fileId!, name: item.name, media_type: item.mediaType, size: item.size }));
    const firstSend = firstClientId ? { clientId: firstClientId, text, files } : this.draft.firstSend;
    const { firstMessageId: _, ...rest } = this.draft;
    this.commit({ ...rest, text: followingText, items: [], ...(firstSend ? { firstSend } : {}) });
    for (const item of items) {
      // The server copy is already durable; a failed local deletion must not prevent send.
      try {
        const file = new File(this.directory, `${item.id}.bin`);
        if (file.exists) file.delete();
      } catch (error) {
        console.warn("Could not remove staged attachment", error);
      }
    }
    return { text, files };
  }

  /** An acquisition can attach to an already-ready controller whose staged files have not started yet. */
  resumeUploads(): void { this.pump(); }

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
  if (!api.config.computerId || api.signal.aborted) throw new Error("上传需要有效的服务器连接");
  const key = draftDirectory(api.config.computerId, conversationId, rootId).uri;
  let controller = controllers.get(key);
  if (!controller) {
    controller = new UploadDraftController(api, conversationId, rootId);
    controllers.set(key, controller);
  }
  const unsubscribe = controller.subscribe(changed);
  if (!controller.ready && !controller.error) controller.initialize();
  else if (controller.ready) controller.resumeUploads();
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

/** What a screen renders: the shared controller plus a fresh object per controller notification. */
export type UploadDraftSnapshot = Readonly<{ controller: UploadDraftController }>;
export type UploadDraftAccess = Readonly<{
  subscribe(changed: () => void): () => void;
  getSnapshot(): UploadDraftSnapshot | null;
}>;

/** `useSyncExternalStore` adapter for one screen's access to a conversation draft.
 * Subscribing is the acquisition and unsubscribing releases only that acquisition; the
 * controller remains the single owner of text, staged bytes, progress and fileIds.
 * An already acquired handoff controller seeds the same snapshot before its new screen subscribes,
 * so first binding cannot briefly blank/disable the input. This does not acquire a second owner. */
export function uploadDraftAccess(api: GatewayApi, conversationId: string, rootId = conversationId, initial?: UploadDraftController): UploadDraftAccess {
  let snapshot: UploadDraftSnapshot | null = initial ? { controller: initial } : null;
  return {
    getSnapshot: () => snapshot,
    subscribe(changed) {
      const access = acquireUploadDraft(api, conversationId, (controller) => {
        snapshot = { controller };
        changed();
      }, rootId);
      return () => {
        access.release();
        snapshot = null;
      };
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

/** Reconcile one computer after its full list loads, without acquiring controllers or resuming uploads. */
export function reconcileConversationDrafts(computerId: string, session: ChatSession): void {
  const root = new Directory(Paths.document, "upload-drafts", encodeURIComponent(computerId));
  if (!root.exists) return;
  for (const entry of root.list()) {
    if (!(entry instanceof Directory)) continue;
    const id = decodeURIComponent(entry.name);
    if (!session.conversations.has(id)) {
      discardConversationDraft(computerId, id);
      continue;
    }
    const pending = (controllers.get(entry.uri)?.draft ?? readDraft(entry).draft).firstSend;
    if (!pending) continue;
    if (session.timelines.get(id)?.events.some(event => event.client_id === pending.clientId)) {
      acknowledgeFirstSendDraft(computerId, id, pending.clientId);
    } else session.restoreFirstSend(id, pending.clientId, pending.text, pending.files);
  }
}

/** Confirmation can arrive while the originating page and its upload controller are absent. */
export function acknowledgeFirstSendDraft(computerId: string, id: string, clientId: string): void {
  const directory = draftDirectory(computerId, id);
  const controller = controllers.get(directory.uri);
  if (controller) { controller.acknowledgeFirstSend(clientId); return; }
  const saved = readDraft(directory);
  if (saved.draft.firstSend?.clientId !== clientId) return;
  const { firstSend: _, ...rest } = saved.draft;
  writeDraft(directory, saved.generation, rest);
}
