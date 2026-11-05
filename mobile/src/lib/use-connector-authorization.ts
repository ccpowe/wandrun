import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useReducer } from 'react';
import { Linking } from 'react-native';
import { GatewayError, type Connector } from '../gateway/api';
import { newClientId, type ChatSession } from '../gateway/session';
import { connectorAuthorizationReducer, initialConnectorAuthorization, selectConnectorAuthorization, type AuthorizationFlow } from './connector-authorization';
import { connectorDetailOptions, readConnectorBeforeSave } from './gateway-queries';
import { useFocusedVisit } from './use-focused-visit';

export function useConnectorAuthorization(session: ChatSession, connector: Connector | undefined) {
  const [state, dispatch] = useReducer(connectorAuthorizationReducer, initialConnectorAuthorization);
  const queryClient = useQueryClient();
  const captureVisit = useFocusedVisit();
  const gatewayRead = connector ? queryClient.getQueryState<Connector>(connectorDetailOptions(session, connector.id).queryKey) : undefined;
  const projected = selectConnectorAuthorization(state, gatewayRead?.data ?? connector);
  if (projected.terminal) dispatch(projected.terminal);
  const flowOwner = connector ? session.editorOperations.get(`connector:${connector.id}`) : undefined;
  const selection = { ...projected, canReopen: !!projected.flow && flowOwner?.operationId === projected.flow.id && flowOwner.status === 'confirmed' };
  const nativeOpen = async (flow: AuthorizationFlow, id: string, stillHere: () => boolean) => {
    const ownsFlow = () => {
      const owner = session.editorOperations.get(`connector:${id}`);
      const read = queryClient.getQueryState<Connector>(connectorDetailOptions(session, id).queryKey);
      const matches = !!read?.data?.auth.authorizing && read.data.auth.transaction_id === flow.value.transaction_id;
      return stillHere() && owner?.operationId === flow.id && owner.status === 'confirmed'
        && matches && !session.deletedConnectorIds.has(id) && flow.value.expires_at * 1000 > Date.now();
    };
    if (!ownsFlow()) return;
    try {
      if (flow.value.flow === 'device_code') {
        const copied = await Clipboard.setStringAsync(flow.value.user_code);
        if (!copied) throw new Error('clipboard');
        if (!ownsFlow()) return;
        await Linking.openURL(flow.value.authorization_url);
      } else {
        await WebBrowser.openAuthSessionAsync(flow.value.authorization_url, 'wandrun://oauth/done');
      }
      if (ownsFlow()) dispatch({ type: 'native-result', flowId: flow.id, notice: flow.value.flow === 'device_code' ? '已复制验证码' : '' });
    } catch {
      if (ownsFlow()) dispatch({ type: 'native-result', flowId: flow.id, error: flow.value.flow === 'device_code'
        ? '无法复制短码或打开授权页，请重试此步骤' : '无法打开系统浏览器，请重新打开授权链接' });
    } finally {
      // The URI result is never authorization proof. One shared Query performs the fresh GET.
      if (stillHere()) { await readConnectorBeforeSave(session, id).catch(() => {}); }
    }
  };
  const start = async (id = connector?.id) => {
    if (!id || session.connection !== 'open') return;
    const key = `connector:${id}`; const owner = session.editorOperations.get(key);
    if (owner?.status === 'pending' || owner?.status === 'unknown') return;
    const operationId = newClientId(); const stillHere = captureVisit();
    dispatch({ type: 'start', operationId });
    try {
      const value = await session.editorOperations.run(key, { operationId, resource: 'connector', id, action: 'authorize' }, () => session.api.startConnectorOAuth(id));
      if (!value) { dispatch({ type: 'failed', operationId, message: '无法发起授权，请检查网关连接后重试。' }); return; }
      // Admit material only after the shared authoritative read matches this start.
      // This also rejects a delayed HTTP receipt overtaken by another device's start.
      let latest: Connector;
      try { latest = await readConnectorBeforeSave(session, id); }
      catch {
        dispatch({ type: 'failed', operationId, message: '授权已发起，但无法读取最新状态，请恢复连接后重新发起授权。' });
        return;
      }
      if (!stillHere() || !latest.auth.authorizing || latest.auth.transaction_id !== value.transaction_id) {
        dispatch({ type: 'finished', operationId, clearFlow: true, message: '' });
        return;
      }
      const flow = { id: operationId, value };
      dispatch({ type: 'started', operationId, value });
      await nativeOpen(flow, id, stillHere);
    } catch (error) {
      const outcome = session.editorOperations.get(key);
      if (outcome?.operationId === operationId && (outcome.status === 'unknown' || outcome.reconciled)) {
        dispatch({ type: 'unconfirmed', operationId }); return;
      }
      dispatch({ type: 'failed', operationId, message: error instanceof GatewayError && error.code === 'unsupported_oauth'
        ? '此服务不支持安全 OAuth，请修改地址或使用其他认证方式' : '无法发起授权，请检查网关连接后重试。' });
    }
  };
  const command = async (action: 'callback' | 'cancel-authorization' | 'disconnect') => {
    if (!connector || session.connection !== 'open') return;
    const id = connector.id; const key = `connector:${id}`;
    const operationId = newClientId(); const owner = session.editorOperations.get(key);
    if (owner?.status === 'pending' || owner?.status === 'unknown') return;
    dispatch({ type: 'command', operationId });
    try {
      const result = await session.editorOperations.run(key, { operationId, resource: 'connector', id, action }, () => action === 'callback'
        ? session.api.completeConnectorOAuth(id, state.callback.trim()) : action === 'cancel-authorization' ? session.api.cancelConnectorOAuth(id) : session.api.revokeConnectorOAuth(id));
      if (!result) { dispatch({ type: 'failed', operationId, message: '操作未完成' }); return; }
      const revoked = 'remote_revoked' in result ? result.remote_revoked : true;
      dispatch({ type: 'finished', operationId, clearFlow: true, message: action === 'disconnect' ? revoked === null
        ? connector.app_id === 'github' ? '本地授权已清除；GitHub 未提供远端撤销接口，请到 GitHub 设置中撤销此应用授权。' : '本地授权已清除；服务方未提供远端撤销接口，请到服务方设置检查授权。'
        : revoked === false ? '本地授权已清除；远端撤销失败，服务方可能仍保留授权，请到服务方设置里断开。' : '授权已断开。'
        : action === 'callback' ? '授权已处理。' : '已取消等待授权。' });
    } catch (error) {
      session.connectorChanged(null);
      const outcome = session.editorOperations.get(key);
      if (outcome?.operationId === operationId && (outcome.status === 'unknown' || outcome.reconciled)) {
        dispatch({ type: 'unconfirmed', operationId }); return;
      }
      dispatch({ type: 'failed', operationId, message: error instanceof GatewayError && error.code === 'remote_revocation_failed'
        ? '本地授权已清除，但远端撤销失败；请到服务方设置里断开，并刷新此页核对状态。'
        : action === 'callback' ? '完整回调网址与本次授权不匹配或已过期，请核对网址，必要时重新发起授权。' : '操作未完成，请恢复连接后核对状态' });
    }
  };
  return { state, selection, start, command,
    callback: (value: string) => dispatch({ type: 'callback', value }),
    reopen: () => { if (connector && selection.flow && selection.canReopen) void nativeOpen(selection.flow, connector.id, captureVisit()); },
    expire: (flowId: string) => {
      if (!connector || queryClient.getQueryData(connectorDetailOptions(session, connector.id).queryKey)?.auth.authorizing === false) return;
      dispatch({ type: 'expired', flowId }); session.connectorChanged(null);
    } };
}
