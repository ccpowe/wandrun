import { Directory, File } from "expo-file-system";

import type { FileRecord } from "../gateway/api.ts";

/** Picker handoff requires a live owner and signal; after acceptance the native
 * save owns its destination, even if the caller switches computers.
 */
export async function saveNativeFile(
  url: string,
  headers: Record<string, string>,
  file: Pick<FileRecord, "name" | "media_type">,
  canStart: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch (cause) {
    // These are the SDK 57 Android and iOS directory-picker cancellation codes.
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
    if (code === "ERR_PICKER_CANCELLED" || code === "ERR_FILE_PICKING_CANCELLED") return false;
    throw cause;
  }
  if (!canStart() || signal.aborted) return false;

  // Android creates a new document; iOS rejects an existing path. Only pass our
  // newly created File to the task: passing Directory could overwrite a child.
  const destination = directory.createFile(file.name, file.media_type);
  let saved = false;
  try {
    // Unlike downloadFileAsync, SDK 57 DownloadTask supports Android SAF URIs.
    // Keep transfer bytes native. Once accepted, navigation does not cancel the
    // save; the SDK's Android buffered-read cancellation path may never settle.
    const task = File.createDownloadTask(url, destination, { headers });
    if (!await task.downloadAsync()) throw new Error("下载未完成");
    saved = true;
    return true;
  } finally {
    if (!saved && destination.exists) destination.delete();
  }
}
