export type PairingPage = 'landing' | 'manual' | 'scan' | 'development';
type Form = { page: PairingPage; address: string; code: string; token: string; error: string; taps: number };
export type ConnectState = (Form & { status: 'ready' })
  | (Form & { status: 'permission' | 'connecting' | 'development-probe' | 'development-save'; operationId: string });
export type ConnectEvent =
  | { type: 'focused' }
  | { type: 'page'; page: PairingPage }
  | { type: 'field'; field: 'address' | 'code' | 'token'; value: string }
  | { type: 'development-tapped' }
  | { type: 'error'; message: string }
  | { type: 'permission-started' | 'connect-started' | 'development-started'; operationId: string }
  | { type: 'permission-finished'; operationId: string; granted: boolean; message: string }
  | { type: 'development-saving'; operationId: string }
  | { type: 'finished'; operationId: string; message?: string }
  | { type: 'cancelled' | 'scan-retried' };

export function initialConnectState(address = ''): ConnectState {
  return { status: 'ready', page: 'landing', address, code: '', token: '', error: '', taps: 0 };
}
function ready(state: Form, page = state.page, error = ''): ConnectState {
  return { status: 'ready', page, address: state.address, code: state.code, token: state.token, taps: state.taps, error };
}
export function connectReducer(state: ConnectState, event: ConnectEvent): ConnectState {
  switch (state.status) {
    case 'ready':
      switch (event.type) {
        case 'focused': return ready(state, 'landing');
        case 'page': return ready(state, event.page);
        case 'field': return { ...state, [event.field]: event.value };
        case 'development-tapped': return state.taps + 1 >= 7 ? { ...state, page: 'development', taps: 0, error: '' } : { ...state, taps: state.taps + 1 };
        case 'error': return { ...state, error: event.message };
        case 'permission-started': return { ...state, status: 'permission', operationId: event.operationId, error: '' };
        case 'connect-started': return { ...state, status: 'connecting', operationId: event.operationId, error: '' };
        case 'development-started': return { ...state, status: 'development-probe', operationId: event.operationId, error: '' };
        case 'scan-retried': return { ...state, error: '' };
        default: return state;
      }
    case 'permission':
      switch (event.type) {
        case 'field': return { ...state, [event.field]: event.value };
        case 'focused': return ready(state, 'landing');
        case 'page': return ready(state, event.page);
        case 'permission-finished': return event.operationId === state.operationId ? ready(state, event.granted ? 'scan' : 'manual', event.message) : state;
        default: return state;
      }
    case 'connecting':
    case 'development-probe':
      switch (event.type) {
        case 'field': return { ...state, [event.field]: event.value };
        case 'focused': return ready(state, 'landing');
        case 'page': return ready(state, event.page);
        case 'cancelled': return ready(state, state.page, '已停止等待。请求若已兑换成功，连接仍会保存；否则请重新生成配对码。');
        case 'finished': return event.operationId === state.operationId ? ready(state, state.page, event.message ?? '') : state;
        case 'development-saving': return state.status === 'development-probe' && event.operationId === state.operationId ? { ...state, status: 'development-save' } : state;
        default: return state;
      }
    case 'development-save':
      switch (event.type) {
        case 'field': return { ...state, [event.field]: event.value };
        case 'focused': return { ...state, page: 'landing' };
        case 'finished': return event.operationId === state.operationId ? ready(state, state.page, event.message ?? '') : state;
        default: return state;
      }
  }
}
export type ConnectSelection = { busy: boolean; saving: boolean; error: string; canCancel: boolean; canChangePage: boolean };
export function selectConnect(state: ConnectState, exchange: { phase: 'idle' | 'exchanging' | 'saving'; error: string }): ConnectSelection {
  const saving = state.status === 'development-save' || exchange.phase === 'saving';
  return { busy: state.status !== 'ready' || exchange.phase !== 'idle', saving, error: exchange.error || state.error,
    canCancel: !saving && (state.status === 'connecting' || state.status === 'development-probe'), canChangePage: !saving };
}
