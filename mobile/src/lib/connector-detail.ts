import type { Connector, ConnectorAgent, PatchConnectorInput } from '../gateway/api.ts';
import type { EditorOperation } from '../gateway/editor-operation.ts';
import type { ConnectorParameterDraft } from './connector-add.ts';
export type ConnectorDetailState = { expanded: boolean; adoptedRecoveryId?: string; notice: string } & (
  | { status: 'ready'; panel: 'main' | 'agents'; error: string }
  | { status: 'metadata'; original: Connector; name: string; description: string; error: string }
  | { status: 'parameters'; original: Connector; draft: ConnectorParameterDraft; error: string }
  | { status: 'checking-delete'; operationId: string }
  | { status: 'confirm-delete'; agents: ConnectorAgent[]; error: string }
  | { status: 'command'; operationId: string; action: 'save' | 'delete' | 'test' | 'disconnect'; previous?: ConnectorDetailState }
  | { status: 'closed' }
);
export type ConnectorDetailEvent =
  | { type: 'metadata'; connector: Connector }
  | { type: 'parameters'; connector: Connector; draft: ConnectorParameterDraft }
  | { type: 'change-metadata'; name?: string; description?: string }
  | { type: 'change-parameters'; fields: Partial<ConnectorParameterDraft> }
  | { type: 'panel'; panel: 'main' | 'agents' }
  | { type: 'toggle-tools' | 'cancel' }
  | { type: 'check-delete'; operationId: string }
  | { type: 'checked-delete'; operationId: string; agents: ConnectorAgent[] }
  | { type: 'command'; operationId: string; action: 'save' | 'delete' | 'test' | 'disconnect' }
  | { type: 'failed'; operationId?: string; message: string }
  | { type: 'finished'; operationId: string; deleted?: boolean; message?: string }
  | { type: 'adopt-recovery'; operationId: string; exists: boolean; secrets?: boolean };
export const initialConnectorDetail = { status: 'ready' as const, panel: 'main' as const, expanded: false, error: '', notice: '', adoptedRecoveryId: undefined as string | undefined } satisfies ConnectorDetailState;
const closedConnectorDetail = { ...initialConnectorDetail, status: 'closed' as const } satisfies ConnectorDetailState;
function adoptRecovery(state: ConnectorDetailState, event: Extract<ConnectorDetailEvent, { type: 'adopt-recovery' }>): ConnectorDetailState {
  if (event.operationId === state.adoptedRecoveryId || (state.status === 'command' && state.operationId !== event.operationId)) return state;
  return { ...initialConnectorDetail, expanded: state.expanded, adoptedRecoveryId: event.operationId,
    notice: event.secrets ? '已读取当前状态，无法确认上次操作是否完成。密钥值不会回读。' : '已读取当前状态，无法确认上次操作是否完成。', status: event.exists ? 'ready' : 'closed' };
}
export function connectorDetailReducer(state: ConnectorDetailState, event: ConnectorDetailEvent): ConnectorDetailState {
  switch (state.status) {
    case 'closed': return state;
    case 'ready':
      switch (event.type) {
        case 'adopt-recovery': return adoptRecovery(state, event);
        case 'metadata': return { ...state, status: 'metadata', original: event.connector, name: event.connector.name, description: event.connector.description, error: '' };
        case 'parameters': return { ...state, status: 'parameters', original: event.connector, draft: event.draft, error: '' };
        case 'panel': return { ...state, panel: event.panel };
        case 'toggle-tools': return { ...state, expanded: !state.expanded };
        case 'check-delete': return { ...state, status: 'checking-delete', operationId: event.operationId };
        case 'command': return event.action === 'test' || event.action === 'disconnect' ? { ...state, status: 'command', operationId: event.operationId, action: event.action, previous: state } : state;
        case 'failed': return { ...state, error: event.message };
        default: return state;
      }
    case 'metadata': case 'parameters':
      switch (event.type) {
        case 'adopt-recovery': return adoptRecovery(state, event);
        case 'cancel': return { ...initialConnectorDetail, expanded: state.expanded, adoptedRecoveryId: state.adoptedRecoveryId };
        case 'failed': return !event.operationId ? { ...state, error: event.message } : state;
        case 'command': return event.action === 'save' ? { ...state, status: 'command', operationId: event.operationId, action: 'save', previous: state } : state;
        case 'change-metadata': return state.status === 'metadata' ? { ...state, name: event.name ?? state.name, description: event.description ?? state.description, error: '' } : state;
        case 'change-parameters': return state.status === 'parameters' ? { ...state, draft: { ...state.draft, ...event.fields }, error: '' } : state;
        default: return state;
      }
    case 'checking-delete':
      switch (event.type) {
        case 'adopt-recovery': return adoptRecovery(state, event);
        case 'checked-delete': return event.operationId === state.operationId ? { ...state, status: 'confirm-delete', agents: event.agents, error: '' } : state;
        // The failure text is the page visit's one-time result (useVisitNotice), not reducer state.
        case 'failed': return event.operationId === state.operationId ? { ...initialConnectorDetail, expanded: state.expanded } : state;
        default: return state;
      }
    case 'confirm-delete':
      switch (event.type) {
        case 'adopt-recovery': return adoptRecovery(state, event);
        case 'cancel': return { ...initialConnectorDetail, expanded: state.expanded };
        case 'command': return event.action === 'delete' ? { ...state, status: 'command', operationId: event.operationId, action: 'delete', previous: state } : state;
        default: return state;
      }
    case 'command':
      switch (event.type) {
        case 'adopt-recovery': return adoptRecovery(state, event);
        case 'finished': return event.operationId === state.operationId ? { ...initialConnectorDetail, status: event.deleted ? 'closed' : 'ready', expanded: state.expanded, notice: event.message ?? '' } : state;
        case 'failed': {
          if (event.operationId !== state.operationId) return state;
          const previous = state.previous;
          // Only dialogs (metadata / delete confirmation) keep their error; it closes with the dialog.
          // Page-level failures (detail, parameters) are published to the page visit by the caller.
          const dialog = previous?.status === 'metadata' || previous?.status === 'confirm-delete';
          return previous && 'error' in previous ? { ...previous, error: dialog ? event.message : '' } : { ...initialConnectorDetail };
        }
        default: return state;
      }
  }
}
export function connectorMetadataFields(original: Connector, name: string, description: string, latest: Connector): PatchConnectorInput {
  if (!name.trim()) throw new Error('请输入连接器名称');
  const fields: PatchConnectorInput = {};
  if (name.trim() !== original.name) fields.name = name.trim();
  if (description !== original.description) fields.description = description;
  for (const key of ['name', 'description'] as const) if (key in fields && original[key] !== latest[key] && fields[key] !== latest[key]) throw new Error('其他设备已修改相同的连接器资料，请返回列表重新打开后再保存');
  return fields;
}
export function selectConnectorDetail(state: ConnectorDetailState, external: { outcome?: EditorOperation; deleted: boolean; offline: boolean; authorizing: boolean }) {
  const gone = external.deleted || state.status === 'closed';
  const unknown = !gone && external.outcome?.status === 'unknown';
  const recovery = !gone && external.outcome?.reconciled && external.outcome.operationId !== state.adoptedRecoveryId
    && (state.status !== 'command' || state.operationId === external.outcome.operationId)
    ? { type: 'adopt-recovery' as const, operationId: external.outcome.operationId, exists: external.outcome.value !== null,
      secrets: external.outcome.action === 'save' && (!!external.outcome.fields?.headers || !!external.outcome.fields?.env) } : undefined;
  const busy = !gone && !unknown && (external.outcome?.status === 'pending' || state.status === 'command' || state.status === 'checking-delete');
  const canWrite = !gone && !unknown && !busy && !recovery && !external.offline && !external.authorizing;
  const display = gone ? closedConnectorDetail : state.status === 'command' && state.previous ? state.previous : state;
  return { gone, unknown, busy, recovery, display,
    canEdit: !gone && !unknown && !busy && !recovery,
    canWrite, canCheckDelete: canWrite && state.status === 'ready', canDelete: canWrite && state.status === 'confirm-delete',
    leaveIdentity: gone ? 'gone' : unknown ? `unknown:${external.outcome?.operationId}` : recovery ? `recovery:${recovery.operationId}` : 'ordinary' };
}
