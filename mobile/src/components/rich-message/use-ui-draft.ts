import { createStateStore } from '@json-render/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ChatSession } from '@/gateway/session.ts';
import type { UiDraft, UiSubmission } from '@/lib/agent-message.ts';
import { submissionError, submissionValues, type RichSpec } from './spec.ts';

export type UiDraftOwner = { session: ChatSession; conversationId: string; timelineId?: string; messageSeq: number; block: number };
const noDraftSubscription = () => () => {};

/** Keep edits and attempts in the ChatSession, so a recycled row can resume even during an in-flight POST. */
export function useUiDraft(spec: RichSpec, submission: UiSubmission | undefined, owner: UiDraftOwner | undefined,
  onSubmit: (values: Record<string, unknown>, clientId: string) => Promise<void>) {
  const [localDraft, setLocalDraft] = useState<UiDraft>(() => ({
    values: spec.state, attempt: null, pending: false, completed: false, error: null,
  }));
  const localDraftRef = useRef(localDraft);
  const timelineId = owner?.timelineId ?? owner?.conversationId ?? "";
  const shared = useSyncExternalStore(owner?.session.subscribe ?? noDraftSubscription,
    () => owner?.session.uiDraftFor(timelineId, owner.messageSeq, owner.block),
    () => undefined);
  const currentDraft = shared ?? localDraft;
  const [store] = useState(() => createStateStore({ ...currentDraft.values, ...submission && submissionValues(spec, submission.values) }));
  const locked = useRef(false);
  const submitted = !!submission;
  const disabled = submitted || currentDraft.pending || currentDraft.completed ||
    (currentDraft.error !== null && !currentDraft.error.editable);

  const save = useCallback((update: (draft: UiDraft) => UiDraft) => {
    const current = owner?.session.uiDraftFor(timelineId, owner.messageSeq, owner.block) ?? localDraftRef.current;
    const next = update(current);
    if (owner) owner.session.saveUiDraft(timelineId, owner.messageSeq, owner.block, next);
    else {
      localDraftRef.current = next;
      setLocalDraft(next);
    }
  }, [owner, timelineId]);
  useEffect(() => store.subscribe(() => {
    const values = store.getSnapshot();
    save((previous) => ({ ...previous, values }));
  }), [store, save]);

  const send = async (retry = false) => {
    const draft = owner?.session.uiDraftFor(timelineId, owner.messageSeq, owner.block) ?? localDraftRef.current;
    if (locked.current || draft.pending || submitted || draft.completed || (!retry && draft.attempt)) return;
    locked.current = true;
    const attempt = draft.attempt ?? {
      clientId: `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      values: submissionValues(spec, store.getSnapshot()),
    };
    save((previous) => ({ ...previous, attempt, pending: true, error: null }));
    try {
      await onSubmit(attempt.values, attempt.clientId);
      // Only the persisted user event is authoritative. Keep the attempt frozen until it arrives.
      save((previous) => ({ ...previous, completed: true }));
    } catch (reason) {
      const failure = submissionError(reason);
      save((previous) => ({ ...previous, attempt: failure.editable ? null : attempt, error: failure }));
    } finally {
      locked.current = false;
      save((previous) => ({ ...previous, pending: false }));
    }
  };
  return { store, currentDraft, disabled, send };
}
