import { createStateStore } from '@json-render/core';
import { useState, useSyncExternalStore } from 'react';
import type { ChatSession } from '@/gateway/session.ts';
import type { UiDraft, UiSubmission } from '@/lib/agent-message.ts';
import { createUiDraftStore, uiDraftReducer, type UiDraftEvent } from '../../lib/ui-draft.ts';
import { useMountEffect } from '../../lib/use-mount-effect.ts';
import { submissionError, submissionValues, type RichSpec } from './spec.ts';

export type UiDraftOwner = { session: ChatSession; conversationId: string; timelineId?: string; messageSeq: number; block: number };

/** Both session-backed and local previews use synchronous reducer admission. Remounting a
 * recycled row reuses the session's frozen operation; only the persisted event makes it read-only. */
export function useUiDraft(spec: RichSpec, submission: UiSubmission | undefined, owner: UiDraftOwner | undefined,
  onSubmit: (values: Record<string, unknown>, clientId: string, actionId?: string) => Promise<void>) {
  const [access] = useState(() => {
    const initial: UiDraft = { values: spec.state, flow: { status: 'editing' } };
    if (!owner) return createUiDraftStore(initial);
    const timelineId = owner.timelineId ?? owner.conversationId;
    const getSnapshot = () => owner.session.uiDraftFor(timelineId, owner.messageSeq, owner.block) ?? initial;
    return {
      getSnapshot, subscribe: owner.session.subscribe,
      dispatch(event: UiDraftEvent) {
        const previous = getSnapshot();
        const next = uiDraftReducer(previous, event);
        if (next === previous || owner.session.submissionsFor(timelineId, owner.messageSeq).has(owner.block)) return false;
        owner.session.saveUiDraft(timelineId, owner.messageSeq, owner.block, next);
        return true;
      },
    };
  });
  const currentDraft = useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
  const readConnection = () => !owner || owner.session.connection === 'open';
  const connected = useSyncExternalStore(access.subscribe, readConnection, readConnection);
  const [store] = useState(() => createStateStore({ ...currentDraft.values,
    ...submission && submissionValues(spec, submission.values) }));
  useMountEffect(() => store.subscribe(() => {
    access.dispatch({ type: 'values', values: store.getSnapshot() });
  }));
  const flow = currentDraft.flow;
  const disabled = !!submission || flow.status !== 'editing' && !(flow.status === 'failed' && flow.error.editable);

  const send = async (retry = false, actionId?: string) => {
    if (submission || owner && owner.session.connection !== 'open') return;
    const current = access.getSnapshot().flow;
    const retained = current.status === 'failed' ? current.attempt : null;
    const attempt = retained ?? {
      clientId: `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      values: submissionValues(spec, store.getSnapshot()), ...(actionId ? { actionId } : {}),
    };
    if (!access.dispatch({ type: 'start', attempt, retry })) return;
    try {
      await onSubmit(attempt.values, attempt.clientId, attempt.actionId);
      access.dispatch({ type: 'accepted', clientId: attempt.clientId });
    } catch (reason) {
      const failure = submissionError(reason, !!attempt.actionId);
      const unknown = !!attempt.actionId && failure.unknown === true;
      access.dispatch({ type: 'failed', clientId: attempt.clientId, failure, unknown });
      if (unknown && owner) void owner.session.recoverUiSubmissions();
    }
  };
  const check = owner ? () => owner.session.recoverUiSubmissions({
    timelineId: owner.timelineId ?? owner.conversationId, messageSeq: owner.messageSeq, block: owner.block,
  }) : undefined;
  return { store, currentDraft, disabled, submitDisabled: disabled || !connected, connected, send, check };
}
