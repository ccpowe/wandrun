import type { AppEntry, Connector } from '../gateway/api.ts';
import { connectorHasFailure } from './connectors.ts';

export type ConnectorHomeState = { status: 'browsing'; tab: 'available' | 'added'; query: string };
export type ConnectorHomeEvent = { type: 'tab'; tab: ConnectorHomeState['tab'] } | { type: 'search'; query: string };
export const initialConnectorHome: ConnectorHomeState = { status: 'browsing', tab: 'available', query: '' };

export function connectorHomeReducer(state: ConnectorHomeState, event: ConnectorHomeEvent): ConnectorHomeState {
  switch (state.status) {
    case 'browsing':
      switch (event.type) {
        case 'tab': return { ...state, tab: event.tab };
        case 'search': return { ...state, query: event.query };
      }
  }
}

/** One secondary line only. Authorization needs attention before transport health does. */
export function connectorListRowState(connector: Connector) {
  if (connector.auth_type === 'key' && !Object.keys(connector.headers ?? {}).length || connector.auth_type === 'oauth' && connector.auth.status !== 'authorized') {
    return { kind: 'authorization' as const, label: '需要授权', failed: false };
  }
  if (connectorHasFailure(connector)) return { kind: 'failure' as const, label: '连接失败', failed: true };
  if (connector.status === 'disconnected') return { kind: 'disconnected' as const, label: '未连接', failed: false };
  return { kind: 'connected' as const, label: '已连接 · {count} 个工具', failed: false };
}

export function connectorListReadFailed(error: unknown, bannerVisible: boolean): boolean {
  return error != null && !bannerVisible;
}

type Read<T> = { data?: T; error: unknown; fetchStatus: 'fetching' | 'paused' | 'idle' };
export type ConnectorHomeSelection = {
  tab: ConnectorHomeState['tab']; query: string; apps: AppEntry[]; connectors: Connector[];
  loading: boolean; readFailed: boolean; stale: boolean; empty: boolean; emptyLabel: string;
};
export function selectConnectorHome(state: ConnectorHomeState, external: {
  apps: Read<{ apps: AppEntry[] }>; connectors: Read<{ connectors: Connector[] }>; connectionBannerVisible: boolean;
}): ConnectorHomeSelection {
  const read = state.tab === 'available' ? external.apps : external.connectors;
  const query = state.query.trim().toLocaleLowerCase();
  const matches = (row: { name: string; description: string }) => `${row.name} ${row.description}`.toLocaleLowerCase().includes(query);
  const apps = (external.apps.data?.apps ?? []).filter(matches);
  const connectors = (external.connectors.data?.connectors ?? []).filter(matches);
  const loaded = read.data !== undefined;
  const failed = read.error != null;
  return {
    tab: state.tab, query: state.query, apps, connectors,
    loading: !loaded && !failed && read.fetchStatus !== 'paused',
    readFailed: connectorListReadFailed(read.error, external.connectionBannerVisible),
    stale: loaded && failed,
    empty: loaded && !failed && (state.tab === 'available' ? apps : connectors).length === 0,
    emptyLabel: query ? '没有找到连接器' : state.tab === 'added' ? '还没有添加连接器' : '暂时没有可用的连接器',
  };
}

export type ConnectorAuthMethod = AppEntry['auth']['type'];
/** Detail and unbound catalog pages share one name per auth method (GitHub catalog / binding = device). */
export function connectorAuthMethodLabel(method: ConnectorAuthMethod): string {
  return method === 'device' ? '短码授权' : method === 'oauth' ? 'OAuth' : method === 'key' ? '密钥' : '无需认证';
}
/** Host of a catalog url for display only; RN's URL polyfill does not implement `host`. */
export function connectorUrlHost(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^[^@]*@/, '');
}
/** One sentence for the current step of an unbound catalog entry, or the not-enabled notice. */
export function catalogConnectHint(method: ConnectorAuthMethod): { text: string; enabled: boolean } {
  if (method === 'oauth') return { text: '将打开浏览器登录 {name} 并授权。', enabled: true };
  if (method === 'device') return { text: '将显示一个短码，在 {name} 网页上输入后完成授权。', enabled: true };
  if (method === 'key') return { text: '连接后填写 {name} 的 Key。', enabled: true };
  return { text: '目录暂未启用这种连接方式', enabled: false };
}
