import type { AgentMemory, MemoryDetail } from '../gateway/api.ts';
import { detailBytes, memoryLength, normalizeMemory, withoutDetailLink } from './agent-memory.ts';
import type { MemoryCheckResult } from './memory-save-check.ts';

type Identity = { sessionId: string; resourceId: string };
export type MemoryEditorKind = 'index' | 'detail' | 'create';
export type MemoryEditorMode = 'reading' | 'editing' | 'reviewing-delete';
export type MemoryEditorForm = Identity & {
  kind: MemoryEditorKind; mode: MemoryEditorMode; base: AgentMemory; detail: MemoryDetail | null; slug: string; content: string;
  deleteIndex: string; blocked: boolean; conflictIndex: AgentMemory | null; conflictDetail?: MemoryDetail | null;
  error: string; result: string; showCurrent: boolean; deleteOpen: boolean;
};
export type MemoryEditorState =
  | (Identity & { status: 'loading'; kind: MemoryEditorKind; slug: string })
  | (MemoryEditorForm & { status: 'ready' })
  | (MemoryEditorForm & { status: 'working'; action: 'save' | 'delete' | 'reload'; operationId: string })
  | (Identity & { status: 'closed' | 'gone' });
export type MemoryEditorEvent =
  | ({ type: 'adopt-initial'; index: AgentMemory; detail: MemoryDetail | null } & Identity)
  | { type: 'change'; content: string }
  | { type: 'slug'; slug: string }
  | { type: 'edit'; index: AgentMemory; detail: MemoryDetail }
  | { type: 'review-delete'; index: AgentMemory; detail: MemoryDetail }
  | { type: 'delete-index'; content: string }
  | { type: 'cancel-delete' }
  | { type: 'delete-dialog'; open: boolean }
  | { type: 'show-current' }
  | { type: 'validation-failed'; message: string }
  | { type: 'started'; action: 'save' | 'delete' | 'reload'; operationId: string }
  | { type: 'failed'; operationId: string; message: string }
  | { type: 'agent-gone'; operationId: string }
  | { type: 'conflict'; operationId: string; index: AgentMemory | null; detail?: MemoryDetail | null }
  | { type: 'reloaded'; operationId: string; index: AgentMemory; detail: MemoryDetail | null }
  | { type: 'checked'; operationId: string; result: MemoryCheckResult; close: boolean }
  | { type: 'saved'; operationId: string; index: AgentMemory; detail: MemoryDetail | null; close: boolean }
  | { type: 'deleted'; operationId: string; close: boolean };

export function memoryEditorReducer(state: MemoryEditorState, event: MemoryEditorEvent): MemoryEditorState {
  switch (state.status) {
    case 'loading':
      if (event.type !== 'adopt-initial' || event.sessionId !== state.sessionId || event.resourceId !== state.resourceId || state.kind === 'detail' && !event.detail) return state;
      return { ...state, status: 'ready', mode: state.kind === 'detail' ? 'reading' : 'editing', base: event.index, detail: event.detail,
        content: state.kind === 'index' ? event.index.content : event.detail?.content ?? '', deleteIndex: '', blocked: false, conflictIndex: null,
        error: '', result: '', showCurrent: false, deleteOpen: false };
    case 'gone':
    case 'closed': return state;
    case 'ready':
      switch (event.type) {
        case 'change': return state.mode === 'editing' ? { ...state, content: normalizeMemory(event.content), error: '', result: '' } : state;
        case 'slug': return state.kind === 'create' ? { ...state, slug: event.slug, error: '', result: '' } : state;
        case 'edit': return state.mode === 'reading' ? { ...state, mode: 'editing', base: event.index, detail: event.detail, content: event.detail.content, blocked: false, conflictIndex: null, error: '', result: '' } : state;
        case 'review-delete': return state.mode === 'reading' ? { ...state, mode: 'reviewing-delete', base: event.index, detail: event.detail, content: event.detail.content, deleteIndex: withoutDetailLink(event.index.content, event.detail.path), blocked: false, conflictIndex: null, error: '', result: '' } : state;
        case 'delete-index': return state.mode === 'reviewing-delete' ? { ...state, deleteIndex: normalizeMemory(event.content), error: '', result: '' } : state;
        case 'cancel-delete': return state.mode === 'reviewing-delete' ? { ...state, mode: 'reading', deleteIndex: '', deleteOpen: false, error: '' } : state;
        case 'delete-dialog': return state.mode === 'reviewing-delete' ? { ...state, deleteOpen: event.open } : state;
        case 'show-current': return { ...state, showCurrent: !state.showCurrent };
        case 'validation-failed': return { ...state, error: event.message };
        case 'started': return { ...state, status: 'working', action: event.action, operationId: event.operationId, error: '', result: '', deleteOpen: false };
        default: return state;
      }
    case 'working': {
      if (!('operationId' in event) || event.operationId !== state.operationId) return state;
      switch (event.type) {
        case 'agent-gone': return { status: 'gone', sessionId: state.sessionId, resourceId: state.resourceId };
        case 'failed': return { ...state, status: 'ready', error: event.message };
        case 'conflict': return { ...state, status: 'ready', blocked: true, conflictIndex: event.index, conflictDetail: event.detail,
          error: state.action === 'delete' ? '删除未完成，请重新加载后重试' : '草稿仍在，重新加载后可保存。' };
        case 'reloaded': {
          if (state.action !== 'reload') return state;
          if (state.kind === 'detail' && !event.detail) return { ...state, status: 'ready', blocked: true, conflictIndex: event.index, conflictDetail: null, error: '详情已删除，草稿仍在。' };
          const suggested = state.detail ? withoutDetailLink(state.base.content, state.detail.path) : '';
          return { ...state, status: 'ready', base: event.index, detail: event.detail, blocked: false, conflictIndex: null, conflictDetail: undefined,
            deleteIndex: state.mode === 'reviewing-delete' && state.deleteIndex === suggested ? withoutDetailLink(event.index.content, event.detail?.path ?? '') : state.deleteIndex,
            content: state.mode === 'reading' ? event.detail?.content ?? '' : state.content, error: '', result: '', showCurrent: false };
        }
        case 'checked': {
          if (state.action === 'reload') return state;
          if (event.result.outcome === 'saved') {
            if (event.close) return { status: 'closed', sessionId: state.sessionId, resourceId: state.resourceId };
            return { ...state, status: 'ready', base: event.result.index, detail: event.result.detail,
              content: state.kind === 'index' ? event.result.index.content : event.result.detail?.content ?? state.content, mode: state.kind === 'index' ? 'editing' : 'reading',
              kind: state.kind === 'create' ? 'detail' : state.kind, blocked: false, conflictIndex: null, error: '', result: '' };
          }
          if (event.result.outcome === 'not-saved') return { ...state, status: 'ready', blocked: false, conflictIndex: null, conflictDetail: undefined, error: '', result: state.action === 'delete' ? '详情尚未删除，核对稿仍在。' : '内容尚未保存，草稿仍在。' };
          return { ...state, status: 'ready', blocked: true, conflictIndex: event.result.index, conflictDetail: event.result.detail, error: state.action === 'delete' ? '删除未完成，请重新加载后重试' : '草稿仍在，重新加载后可保存。' };
        }
        case 'saved':
          if (state.action !== 'save') return state;
          if (event.close) return { status: 'closed', sessionId: state.sessionId, resourceId: state.resourceId };
          return { ...state, status: 'ready', base: event.index, detail: event.detail, kind: state.kind === 'create' ? 'detail' : state.kind,
            mode: state.kind === 'index' ? 'editing' : 'reading', blocked: false, conflictIndex: null, error: '', result: '' };
        case 'deleted': return state.action === 'delete' ? { status: 'closed', sessionId: state.sessionId, resourceId: state.resourceId } : state;
        default: return state;
      }
    }
  }
}

export type MemoryEditorExternal = Identity & {
  index?: AgentMemory; detail?: MemoryDetail | null; indexFresh: boolean; detailFresh: boolean; deleted: boolean;
  checkStatus: 'idle' | 'checking' | 'unknown'; offline: boolean;
};
export type MemoryEditorSelection = {
  phase: 'loading' | 'missing' | 'gone' | 'closed' | 'ready' | 'busy' | 'unknown'; form: MemoryEditorForm | null;
  index?: AgentMemory; detail: MemoryDetail | null; remoteIndex: AgentMemory | null; remoteDetail?: MemoryDetail | null;
  conflict: boolean; missing: boolean; dirty: boolean; busy: boolean; canEdit: boolean; canSave: boolean; canReload: boolean; canOpen: boolean;
  canStartEdit: boolean; canDelete: boolean; canBack: boolean; count: number; limit: number; error: string; adoption: MemoryEditorEvent | null;
  leaveIdentity: string;
};
export function selectMemoryEditor(state: MemoryEditorState, external: MemoryEditorExternal): MemoryEditorSelection {
  const form = state.status === 'ready' || state.status === 'working' ? state : null;
  const kind = 'kind' in state ? state.kind : undefined;
  const reading = form?.mode === 'reading';
  const coherent = external.index !== undefined && (kind !== 'detail' || external.detail !== undefined && (!external.detail || external.detail.version === external.index.version));
  const missing = kind === 'detail' && coherent && external.detail === null;
  const gone = state.status === 'gone' || external.deleted || state.sessionId !== external.sessionId || state.resourceId !== external.resourceId;
  const unknown = external.checkStatus !== 'idle';
  const busy = !gone && !unknown && state.status === 'working';
  const phase = gone ? 'gone' : state.status === 'closed' ? 'closed' : unknown ? 'unknown' : busy ? 'busy' : missing && (!form || reading) ? 'missing' : state.status === 'loading' ? 'loading' : 'ready';
  const index = reading && coherent ? external.index : form?.base;
  const detail = reading && coherent ? external.detail ?? null : form?.detail ?? null;
  const remoteIndex = !reading && form ? external.index && external.index.version !== form.base.version ? external.index : form.conflictIndex : null;
  const remoteDetail = remoteIndex && external.detail?.version === remoteIndex.version ? external.detail
    : remoteIndex && !remoteIndex.details[form?.slug ?? ''] ? null : form?.conflictDetail;
  const conflict = !!form && !reading && (form.blocked || !!remoteIndex);
  const count = form ? kind === 'index' ? memoryLength(form.content) : detailBytes(form.content) : 0;
  const limit = kind === 'index' ? form?.base.limit ?? 1000 : form?.detail?.limit ?? 65536;
  const dirty = !!form && (form.mode === 'reviewing-delete' || form.mode === 'editing' && (form.content !== (kind === 'index' ? form.base.content : form.detail?.content ?? '') || kind === 'create' && !!form.slug));
  const ready = phase === 'ready';
  const adoption: MemoryEditorEvent | null = state.status === 'loading' && coherent && !missing && external.indexFresh && (kind !== 'detail' || external.detailFresh) && !gone
    ? { type: 'adopt-initial', sessionId: external.sessionId, resourceId: external.resourceId, index: external.index!, detail: external.detail ?? null } : null;
  return { phase, form, index, detail, remoteIndex, remoteDetail, conflict, missing, dirty, busy, count, limit, adoption,
    canEdit: ready && !!form && form.mode === 'editing', canSave: ready && form?.mode === 'editing' && !conflict && count <= limit && (kind === 'index' || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(form?.slug ?? '')),
    canReload: ready && !!form, canOpen: ready, canStartEdit: ready && reading && coherent && !!detail && !missing,
    canDelete: ready && !!form && kind === 'detail' && (!reading || coherent) && !conflict && !missing, canBack: !busy,
    error: missing && form && !reading ? '详情已删除，草稿仍在。' : form?.error === '详情已删除，草稿仍在。' && !missing ? '' : form?.error ?? '',
    leaveIdentity: `${external.sessionId}:${external.resourceId}:${gone ? 'gone' : unknown && state.status === 'working' ? state.operationId : 'ordinary'}` };
}
