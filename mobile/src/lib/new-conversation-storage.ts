import { Directory, File, Paths } from 'expo-file-system';
import { z } from 'zod';
import { NewConversationStore, type NewChatSaved, type StagedNewAttachment } from './new-conversation.ts';
import { mimeForFile } from './upload-draft-state.ts';
import type { PickedUpload } from './upload-drafts.ts';

const selection = z.object({ computerId: z.string(), agentId: z.string() });
const attachment = z.object({ id: z.string(), uri: z.string(), name: z.string(), mediaType: z.string(), size: z.number() });
const attempt = selection.extend({ clientId: z.string(), messageClientId: z.string(), kind: z.enum(['send', 'attachments']), text: z.string(), files: z.array(attachment), conversationId: z.string().optional(), deferred: z.literal(true).optional() });
const saved = z.object({
  text: z.string(), selection: selection.nullable(), attempt: attempt.optional(),
  failure: z.object({ attempt, error: z.string(), reason: z.string().optional() }).optional(),
});
const snapshot = z.object({ generation: z.number().int().nonnegative(), saved });
function directory() { return new Directory(Paths.document, 'new-conversation'); }

function discardStaged(files?: StagedNewAttachment[]): void {
  if (!files?.length) return;
  const root = directory();
  for (const item of files) {
    // Delete only files allocated by this staging directory, never picker originals.
    if (!/^[\w-]+$/.test(item.id)) continue;
    const file = new File(root, `${item.id}.bin`);
    if (file.uri !== item.uri) continue;
    try { if (file.exists) file.delete(); }
    catch { console.warn('清理新对话暂存附件失败'); }
  }
}

function ownedFiles(value: NewChatSaved | null): StagedNewAttachment[] {
  return value?.attempt?.files ?? value?.failure?.attempt.files ?? [];
}

/** Failed first intents keep their bytes; retry may give the same bytes a fresh creation key. */
function discardUnreferenced(files: StagedNewAttachment[], kept: StagedNewAttachment[]): void {
  discardStaged(files.filter(item => !kept.some(other => other.uri === item.uri)));
}

/** Same two committed slots as conversation upload drafts; a torn newest write cannot destroy the previous one. */
export function nativeNewConversation(): NewConversationStore {
  let generation = 0;
  let previous: NewChatSaved | null = null;
  return new NewConversationStore({
    read() {
      let existed = false;
      const values = ['draft-a.json', 'draft-b.json'].flatMap(name => {
        const file = new File(directory(), name);
        if (!file.exists) return [];
        existed = true;
        try {
          const value = snapshot.parse(JSON.parse(file.textSync()));
          return [value];
        } catch { return []; }
      }).sort((a, b) => b.generation - a.generation);
      if (!values.length && existed) throw new Error('无法读取草稿');
      generation = values[0]?.generation ?? 0;
      previous = values[0]?.saved ?? null;
      return previous;
    },
    write(value: NewChatSaved) {
      const next = generation + 1;
      try {
        const root = directory();
        root.create({ intermediates: true, idempotent: true });
        const temp = new File(root, 'draft.tmp');
        temp.write(JSON.stringify({ generation: next, saved: value }));
        temp.moveSync(new File(root, next % 2 ? 'draft-a.json' : 'draft-b.json'), { overwrite: true });
      } catch (error) {
        // A new intent has not issued HTTP until this write succeeds.
        discardUnreferenced(ownedFiles(value), ownedFiles(previous));
        throw error;
      }
      generation = next;
      const ended = ownedFiles(previous);
      previous = value;
      discardUnreferenced(ended, ownedFiles(value));
    },
  });
}

/** One source-to-owned copy, before network creation. Binding later moves these bytes, never copies/reuploads them. */
export async function stageNewAttachments(picked: PickedUpload[], operation: string): Promise<StagedNewAttachment[]> {
  const root = directory();
  root.create({ intermediates: true, idempotent: true });
  const result: StagedNewAttachment[] = [];
  const allocated: File[] = [];
  try {
    for (const [index, item] of picked.entries()) {
      const id = `${operation}-${index}`;
      const target = new File(root, `${id}.bin`);
      allocated.push(target);
      await new File(item.uri).copy(target);
      result.push({ id, uri: target.uri, name: item.name, mediaType: mimeForFile(item.name, item.mimeType), size: target.size });
    }
    return result;
  } catch (error) {
    for (const file of allocated) {
      if (file.exists) file.delete();
    }
    throw error;
  }
}
