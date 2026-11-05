export type DrawerTarget = Readonly<{ id: string; title: string; drawerVisit: object }>;
export type DrawerOverlay =
  | { status: 'closed' }
  | { status: 'menu'; target: DrawerTarget; point: { pageX: number; pageY: number }; menuVisit: object }
  | { status: 'renaming'; target: DrawerTarget; title: string; error: string }
  | { status: 'saving'; target: DrawerTarget; title: string; operationId: string }
  | { status: 'rename-closing'; target: DrawerTarget; title: string }
  | { status: 'delete-confirm'; target: DrawerTarget; error: string }
  | { status: 'deleting'; target: DrawerTarget; operationId: string };
export type DrawerOverlayEvent =
  | { type: 'open-menu'; target: DrawerTarget; point: { pageX: number; pageY: number }; menuVisit: object; replacesMissing?: string }
  | { type: 'rename' | 'delete' | 'dismiss-menu' | 'cancel' }
  | { type: 'rename-closing' | 'rename-closed'; target: DrawerTarget }
  | { type: 'change'; title: string }
  | { type: 'submit'; operationId: string }
  | { type: 'succeeded'; operationId: string }
  | { type: 'failed'; operationId: string; message: string };

export function validDrawerTitle(title: string): boolean {
  const value = title.trim();
  return value.length > 0 && Array.from(value).length <= 200;
}

function replacesTarget(state: Exclude<DrawerOverlay, { status: 'closed' }>, event: Extract<DrawerOverlayEvent, { type: 'open-menu' }>) {
  return event.target.drawerVisit !== state.target.drawerVisit || event.replacesMissing === state.target.id;
}

/** Only user intent and the matching command result enter this local reducer. */
export function drawerOverlayReducer(state: DrawerOverlay, event: DrawerOverlayEvent): DrawerOverlay {
  switch (state.status) {
    case 'closed':
      return event.type === 'open-menu' ? { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit } : state;
    case 'menu':
      switch (event.type) {
        case 'open-menu': return { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit };
        case 'rename': return { status: 'renaming', target: state.target, title: state.target.title, error: '' };
        case 'delete': return { status: 'delete-confirm', target: state.target, error: '' };
        case 'cancel': case 'dismiss-menu': return { status: 'closed' };
        default: return state;
      }
    case 'renaming':
      switch (event.type) {
        case 'open-menu': return replacesTarget(state, event) ? { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit } : state;
        case 'change': return { ...state, title: event.title, error: '' };
        case 'cancel': return { status: 'rename-closing', target: state.target, title: state.title };
        case 'rename-closing': return event.target === state.target ? { status: 'rename-closing', target: state.target, title: state.title } : state;
        case 'rename-closed': return event.target === state.target ? { status: 'closed' } : state;
        case 'submit': return validDrawerTitle(state.title)
          ? { status: 'saving', target: state.target, title: state.title, operationId: event.operationId } : state;
        default: return state;
      }
    case 'delete-confirm':
      switch (event.type) {
        case 'open-menu': return replacesTarget(state, event) ? { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit } : state;
        case 'cancel': return { status: 'closed' };
        case 'submit': return { status: 'deleting', target: state.target, operationId: event.operationId };
        default: return state;
      }
    case 'saving':
      if (event.type === 'open-menu' && replacesTarget(state, event)) return { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit };
      if (!('operationId' in event) || event.operationId !== state.operationId) return state;
      if (event.type === 'succeeded') return { status: 'rename-closing', target: state.target, title: state.title };
      if (event.type === 'failed') return { status: 'renaming', target: state.target, title: state.title, error: event.message };
      return state;
    case 'rename-closing':
      if (event.type === 'open-menu' && replacesTarget(state, event)) return { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit };
      return event.type === 'rename-closed' && event.target === state.target ? { status: 'closed' } : state;
    case 'deleting':
      if (event.type === 'open-menu' && replacesTarget(state, event)) return { status: 'menu', target: event.target, point: event.point, menuVisit: event.menuVisit };
      if (!('operationId' in event) || event.operationId !== state.operationId) return state;
      if (event.type === 'succeeded') return { status: 'closed' };
      if (event.type === 'failed') return { status: 'delete-confirm', target: state.target, error: event.message };
      return state;
  }
}

/** Resource deletion wins over every local phase; ordinary title updates never overwrite the draft. */
export function selectDrawerOverlay(state: DrawerOverlay, external: { open: boolean; connected: boolean; hasTarget: boolean; menuVisit: object; drawerVisit: object }) {
  const visible = external.open && external.hasTarget && state.status !== 'closed' && state.target.drawerVisit === external.drawerVisit;
  const busy = visible && (state.status === 'saving' || state.status === 'deleting' || state.status === 'rename-closing');
  return {
    overlay: visible && (state.status !== 'menu' || external.connected && state.menuVisit === external.menuVisit) ? state : null,
    busy,
    canSubmit: visible && external.connected && (state.status === 'renaming' && validDrawerTitle(state.title) || state.status === 'delete-confirm'),
  };
}

/**
 * One reducer snapshot is both the UI source and synchronous command admission.
 * React subscribes to it; send() never runs commands, so reducer/render replay cannot write.
 */
export class DrawerOverlayOwner {
  private state: DrawerOverlay = { status: 'closed' };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): DrawerOverlay => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  send = (event: DrawerOverlayEvent): boolean => {
    const next = drawerOverlayReducer(this.state, event);
    if (next === this.state) return false;
    this.state = next;
    for (const listener of this.listeners) listener();
    return true;
  };
}
