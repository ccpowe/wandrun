import type { Connector, OAuthStart } from '../gateway/api.ts';
export type AuthorizationFlow = { id: string; value: OAuthStart };
export type ConnectorAuthorizationState =
  | { status: 'idle'; flow?: AuthorizationFlow; callback: string; error: string; notice: string }
  | { status: 'expired'; flow?: undefined; callback: ''; error: ''; notice: string }
  | { status: 'command'; operationId: string; flow?: AuthorizationFlow; callback: string };
export type ConnectorAuthorizationEvent =
  | { type: 'start'; operationId: string }
  | { type: 'command'; operationId: string }
  | { type: 'started'; operationId: string; value: OAuthStart }
  | { type: 'finished'; operationId: string; message: string; clearFlow?: boolean }
  | { type: 'failed'; operationId: string; message: string }
  | { type: 'unconfirmed'; operationId: string }
  | { type: 'callback'; value: string }
  | { type: 'native-result'; flowId: string; error?: string; notice?: string }
  | { type: 'gateway-terminal'; flowId: string }
  | { type: 'expired'; flowId: string };
export const initialConnectorAuthorization: ConnectorAuthorizationState = { status: 'idle', callback: '', error: '', notice: '' };
export function connectorAuthorizationReducer(state: ConnectorAuthorizationState, event: ConnectorAuthorizationEvent): ConnectorAuthorizationState {
  switch (state.status) {
    case 'idle': case 'expired':
      switch (event.type) {
        case 'start': return { status: 'command', operationId: event.operationId, callback: '' };
        case 'command': return { status: 'command', operationId: event.operationId, flow: state.flow, callback: state.callback };
        case 'callback': return state.status === 'idle' && state.flow ? { ...state, callback: event.value } : state;
        case 'native-result': return state.status === 'idle' && state.flow?.id === event.flowId ? { ...state, error: event.error ?? '', notice: event.notice ?? '' } : state;
        case 'gateway-terminal': return state.flow?.id === event.flowId ? initialConnectorAuthorization : state;
        case 'expired': return state.flow?.id === event.flowId ? { status: 'expired', callback: '', error: '', notice: '本次授权已过期，请重新发起授权。' } : state;
        default: return state;
      }
    case 'command':
      switch (event.type) {
        case 'started': return event.operationId === state.operationId ? { status: 'idle', callback: '', error: '', notice: '', flow: { id: event.operationId, value: event.value } } : state;
        case 'finished': return event.operationId === state.operationId ? { status: 'idle', callback: '', error: '', notice: event.message, flow: event.clearFlow ? undefined : state.flow } : state;
        case 'failed': return event.operationId === state.operationId ? { status: 'idle', callback: state.callback, flow: state.flow, error: event.message, notice: '' } : state;
        case 'unconfirmed': return event.operationId === state.operationId ? initialConnectorAuthorization : state;
        case 'gateway-terminal': return state.flow?.id === event.flowId ? { ...state, flow: undefined, callback: '' } : state;
        default: return state;
      }
  }
}
export function selectConnectorAuthorization(state: ConnectorAuthorizationState, connector: Connector | undefined) {
  const matches = !!state.flow && !!connector?.auth.authorizing && connector.auth.transaction_id === state.flow.value.transaction_id;
  const flow = matches ? state.flow : undefined;
  // A flow is adopted only after a fresh post-start GET matched this transaction.
  const terminal = state.flow && connector && !matches
    ? { type: 'gateway-terminal' as const, flowId: state.flow.id } : undefined;
  const completed = connector?.auth.status === 'authorized' && !connector.auth.authorizing;
  return { flow, terminal, waiting: !!connector?.auth.authorizing, busy: state.status === 'command', callback: state.callback,
    error: state.status === 'command' ? '' : state.error,
    notice: state.status === 'command' || state.status === 'expired' && completed ? '' : state.notice };
}
