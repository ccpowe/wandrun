import type { Connector } from '../gateway/api.ts';
import { t } from './i18n.ts';

export function connectorHasFailure(connector: Connector): boolean {
  return connector.status === 'failed' || !!connector.error;
}

/** Agent selection keeps transport health separate from authorization and carrying mode. */
export function connectorStatus(connector: Connector): { label: string; failed: boolean } {
  if (connectorHasFailure(connector)) return { label: connector.error ? t('连接失败：{error}', { error: t(connector.error) }) : t('连接失败'), failed: true };
  if (connector.status === 'connected') return { label: t('已连接'), failed: false };
  if (!connector.used_by.length) return { label: t('没有 Agent 使用，不会连接'), failed: false };
  return { label: t('未连接'), failed: false };
}
export function connectorAuthLabel(connector: Connector): string {
  if (connector.auth_type === 'none') return t('无需授权');
  if (connector.auth_type === 'key') return t('密钥');
  if (connector.auth.status === 'authorized') return t('已授权');
  if (connector.auth.status === 'reauthorization_required') return t('需重新授权');
  if (connector.auth.authorizing) return t('等待授权');
  return t('未授权');
}
