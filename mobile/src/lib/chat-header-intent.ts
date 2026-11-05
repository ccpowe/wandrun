export type CollaborationPanel = { status: 'closed' } | { status: 'open' | 'closing'; visitId: string };
export type CollaborationPanelEvent = { type: 'open'; visitId: string } | { type: 'close' } | { type: 'closed'; visitId: string };
export function collaborationPanelReducer(state: CollaborationPanel, event: CollaborationPanelEvent): CollaborationPanel {
  switch (state.status) {
    case 'closed': return event.type === 'open' ? { status: 'open', visitId: event.visitId } : state;
    case 'open': return event.type === 'close' ? { ...state, status: 'closing' } : state;
    case 'closing':
      if (event.type === 'open') return { status: 'open', visitId: event.visitId };
      if (event.type === 'closed' && event.visitId === state.visitId) return { status: 'closed' };
      return state;
  }
}

