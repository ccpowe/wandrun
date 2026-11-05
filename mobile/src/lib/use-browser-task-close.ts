import { useReducer, useSyncExternalStore } from 'react';
import { newClientId, type ChatSession } from '@/gateway/session.ts';
import { browserTaskCloseReducer } from './browser-task-close.ts';
import { userErrorMessage } from './user-error.ts';

/** Swipe + X is the confirmed interaction: execute immediately, without another dialog.
 * Session owns unknown outcomes after this view leaves; local state only tracks the user's command. */
export function useBrowserTaskClose(session: ChatSession, taskIds: readonly string[]) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const [state, dispatch] = useReducer(browserTaskCloseReducer, { status: 'idle', error: '' });
  let unknown = false;
  const blockedReasons = new Map<string, string>();
  for (const id of taskIds) {
    const outcome = session.editorOperations.get(`browser:${id}`);
    if (outcome?.status !== 'unknown') continue;
    if (outcome.action === 'delete') unknown = true;
    else blockedReasons.set(id, '此任务操作结果未确认，暂时不能关闭');
  }
  const canClose = (taskId: string) => {
    const outcome = session.editorOperations.get(`browser:${taskId}`);
    return state.status !== 'running' && session.connection === 'open'
      && outcome?.status !== 'pending' && outcome?.status !== 'unknown';
  };
  const close = async (taskId: string) => {
    if (!canClose(taskId)) return;
    const key = `browser:${taskId}`;
    const operationId = newClientId();
    dispatch({ type: 'start', taskId, operationId });
    try {
      await session.editorOperations.run(key, { operationId, resource: 'browser', id: taskId, action: 'delete' }, () => session.api.closeBrowser(taskId));
      dispatch({ type: 'settled', operationId, error: '' });
    } catch (cause) {
      const outcome = session.editorOperations.get(key);
      const checking = outcome?.operationId === operationId && (outcome.status === 'unknown' || outcome.reconciled);
      dispatch({ type: 'settled', operationId, error: checking ? '' : userErrorMessage(cause, '无法关闭浏览器任务') });
    }
  };
  const unknownError = session.connection === 'open' ? '操作结果未确认，正在核对结果' : '操作结果未确认，恢复连接后会核对结果';
  return { close, canClose, blockedReasons, unknown,
    error: unknown ? unknownError : state.status === 'idle' ? state.error : '' };
}
