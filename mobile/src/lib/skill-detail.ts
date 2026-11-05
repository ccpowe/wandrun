import type { SkillDeletionState } from './skill-deletion.ts';

export type SkillDetailInteractionState = { status: 'content' } | { status: 'users' };
export type SkillDetailInteractionEvent = { type: 'users-opened' } | { type: 'users-closed' };
export function skillDetailInteractionReducer(state: SkillDetailInteractionState, event: SkillDetailInteractionEvent): SkillDetailInteractionState {
  switch (state.status) {
    case 'content': return event.type === 'users-opened' ? { status: 'users' } : state;
    case 'users': return event.type === 'users-closed' ? { status: 'content' } : state;
  }
}
export type SkillDetailSelection = {
  gone: boolean; usersOpen: boolean; deleting: boolean; canDelete: boolean; dialog: 'blocked' | 'confirm' | null;
};
export function selectSkillDetail(state: SkillDetailInteractionState, action: SkillDeletionState, input: { gone: boolean; focused: boolean; online: boolean; users: number }): SkillDetailSelection {
  const gone = input.gone || action.phase === 'deleted';
  const deleting = action.phase === 'checking' || action.phase === 'deleting';
  const dialog = gone || !input.focused ? null : action.phase === 'blocked' ? 'blocked' : action.phase === 'confirm' || action.phase === 'deleting' ? 'confirm' : null;
  return { gone, usersOpen: !gone && input.focused && input.users > 1 && state.status === 'users', deleting,
    canDelete: !gone && input.online && !deleting && action.phase !== 'unknown', dialog };
}
export type SkillUser = { id: string; name: string; avatar?: number };
