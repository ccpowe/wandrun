import { skipToken } from '@tanstack/react-query';
import { router, Stack, useFocusEffect } from 'expo-router';
import { ChevronLeft, CircleAlert } from 'lucide-react-native';
import { useCallback, useReducer, useRef, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardController } from 'react-native-keyboard-controller';
import { ConnectorCatalogView } from '@/components/connector-catalog-view';
import { ConnectorDetailView } from '@/components/connector-detail-view';
import { ConnectorLeaveBoundary, type ConnectorLeaveControl } from '@/components/connector-leave-boundary';
import { ConnectorOAuthView } from '@/components/connector-oauth';
import { ConnectorParameterForm } from '@/components/connector-parameter-form';
import { ScreenBar } from '@/components/screen-bar';
import { StatusBanner } from '@/components/status-banner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { GatewayError, type Connector, type ConnectorTestResult, type CreateConnectorInput, type GatewayEvent, type PatchConnectorInput } from '@/gateway/api';
import { newClientId, type ChatSession } from '@/gateway/session';
import { blankConnectorParameters, connectorAddReducer, connectorCreateFailure, connectorParameterFields, keyParametersFromConnector, parametersFromConnector, selectConnectorAdd } from '@/lib/connector-add';
import { connectorDetailReducer, connectorMetadataFields, initialConnectorDetail, selectConnectorDetail } from '@/lib/connector-detail';
import { connectorListRowState } from '@/lib/connector-list-state';
import { ConnectionBanner, useConnectionLabel } from '@/lib/connection-banner';
import { appCatalogOptions, connectorAgentsOptions, connectorDetailOptions, connectorToolsOptions, readConnectorBeforeSave, readConnectorDeletionAgents } from '@/lib/gateway-queries';
import { useTranslation } from '@/lib/i18n';
import { useConnectorAuthorization } from '@/lib/use-connector-authorization';
import { useFocusedVisit, useVisitNotice } from '@/lib/use-focused-visit';
import { useGatewayQuery } from '@/lib/use-gateway-query';
import { useMountEffect } from '@/lib/use-mount-effect';
import { userErrorMessage } from '@/lib/user-error';
import { useDelayedNotice } from '@/lib/use-delayed-notice';

function AuthorizationExpiry({ id, expiresAt, expire }: { id: string; expiresAt: number; expire: (id: string) => void }) {
  useMountEffect(() => { const timer = setTimeout(() => expire(id), Math.max(0, expiresAt * 1000 - Date.now())); return () => clearTimeout(timer); });
  return null;
}
function OutcomeNavigation({ gone, recoveredId }: { gone: boolean; recoveredId?: string }) {
  useFocusEffect(useCallback(() => {
    if (gone) router.dismissTo('/settings-connectors');
    else if (recoveredId) router.replace({ pathname: '/connectors/[id]', params: { id: recoveredId } });
  }, [gone, recoveredId]));
  return null;
}
/** One visit owns create -> authorize -> detail. Newly created detail stays in this route until leaving;
 * this keeps the browser transaction local instead of a session/global link handoff. */
export function ConnectorFlow({ session, id, mode = 'remote', appId }: { session: ChatSession; id?: string; mode?: 'remote' | 'local'; appId?: string }) {
  return <ConnectorFlowContainer key={`${session.queryIdentity}:${id ?? appId ?? mode}`} session={session} id={id} mode={mode} appId={appId} />;
}
function ConnectorFlowContainer({ session, id, mode, appId }: { session: ChatSession; id?: string; mode: 'remote' | 'local'; appId?: string }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const { t } = useTranslation(); const captureVisit = useFocusedVisit();
  const [add, addEvent] = useReducer(connectorAddReducer, id ? { status: 'created', id } : { status: 'editing', draft: blankConnectorParameters(mode), authTouched: false, error: '' });
  const catalog = useGatewayQuery(appId ? appCatalogOptions(session) : skipToken);
  const entry = catalog.data?.apps.find(row => row.id === appId);
  const resourceId = add.status === 'created' ? add.id : entry?.connector?.id;
  const read = useGatewayQuery(resourceId ? connectorDetailOptions(session, resourceId) : skipToken);
  const connector = read.data;
  const operationKey = `connector:${resourceId ?? 'new'}`;
  const outcome = session.editorOperations.get(operationKey);
  const [detail, detailEvent] = useReducer(connectorDetailReducer, { ...initialConnectorDetail, adoptedRecoveryId: outcome?.reconciled ? outcome.operationId : undefined });
  // A detail opened by id still needs the catalog's Key declaration (shared /apps Query). Right after a
  // catalog connect the Key page may open before the detail read lands, so fall back to its original.
  const keyConnector = connector ?? (detail.status === 'parameters' ? detail.original : undefined);
  const ownerCatalog = useGatewayQuery(!appId && keyConnector?.app_id && keyConnector.auth_type === 'key' ? appCatalogOptions(session) : skipToken);
  const app = appId ? entry : ownerCatalog.data?.apps.find(row => row.id === keyConnector?.app_id);
  const keyEntry = app?.auth.type === 'key' && keyConnector?.auth_type === 'key' ? { name: app.auth.key.name, url: app.auth.key_url } : undefined;
  // connector-auth.AU10: the catalog Key declaration is a precondition of the Key draft. Until it is
  // ready no parameters draft can be adopted, so a late catalog never re-shapes a draft in progress.
  const parametersReady = !(keyConnector?.app_id && keyConnector.auth_type === 'key') || !!keyEntry;
  const parametersOf = (row: Connector) => keyEntry ? keyParametersFromConnector(row, keyEntry.name) : parametersFromConnector(row);
  const auth = useConnectorAuthorization(session, connector);
  const offline = session.connection !== 'open';
  const deleted = !!resourceId && (session.deletedConnectorIds.has(resourceId) || read.error instanceof GatewayError && read.error.status === 404);
  const external = { outcome, deleted, offline, authorizing: auth.selection.waiting || auth.selection.busy };
  const selected = selectConnectorDetail(detail, external);
  // connector-detail S2: failures shown on the detail / parameters page belong to the visit that started them.
  const result = useVisitNotice();
  const added = selectConnectorAdd(add, session.editorOperations.get('connector:new'), offline);
  const unknown = resourceId ? selected.unknown : added.unknown;
  const references = useGatewayQuery(resourceId ? connectorAgentsOptions(session, resourceId) : skipToken);
  const tools = useGatewayQuery(resourceId && connector && connectorListRowState(connector).kind === 'connected' ? connectorToolsOptions(session, resourceId) : skipToken);
  const connectionLabel = useConnectionLabel(session);
  const leaveControl = useRef<ConnectorLeaveControl>(null);
  const display = selected.display;
  const isParameters = display.status === 'parameters';
  const isMetadata = display.status === 'metadata';
  const dirty = resourceId ? isMetadata ? display.name !== display.original.name || display.description !== display.original.description
    : isParameters ? JSON.stringify(display.draft) !== JSON.stringify(parametersOf(display.original)) : false
    : add.status !== 'created' && (!!add.draft.url.trim() || !!add.draft.commandLine.trim() || add.draft.env.length > 0 || add.draft.auth !== 'none');
  const readError = resourceId ? read.error ?? references.error ?? tools.error : catalog.error;
  const readErrorIdentity = resourceId
    ? [read.error && "detail", references.error && "agents", tools.error && "tools"].filter(Boolean).join("|")
    : catalog.error ? "catalog" : "";
  const showReadError = useDelayedNotice(readErrorIdentity ? `${resourceId ?? appId}:${readErrorIdentity}` : ownerCatalog.error ? `owner-catalog:${keyConnector?.app_id}` : null);
  const showAddedUnknown = useDelayedNotice(added.unknown ? 'creation' : null);
  if (selected.recovery) detailEvent(selected.recovery);
  if (added.recovery) addEvent(added.recovery);
  const current = () => selectConnectorDetail(detail, { ...external, outcome: session.editorOperations.get(operationKey), offline: session.connection !== 'open', deleted: !!resourceId && session.deletedConnectorIds.has(resourceId) || deleted });
  const acceptEvent = (event: GatewayEvent | null | undefined) => { if (event) session.connectorChanged(event); };
  const prepareAuthorization = async (createdId: string) => {
    const stillHere = captureVisit();
    addEvent({ type: 'authorization-check', id: createdId });
    let latest: Connector;
    try { latest = await readConnectorBeforeSave(session, createdId); }
    catch {
      if (stillHere()) addEvent({ type: 'authorization-failed', id: createdId, message: '连接器已添加，但无法读取最新授权状态，请重试发起授权。' });
      return;
    }
    if (!stillHere()) return;
    addEvent({ type: 'authorization-ready', id: createdId });
    if (latest.auth_type === 'oauth' && latest.auth.status !== 'authorized' && !latest.auth.authorizing) await auth.start(createdId);
  };
  const banner = unknown ? null : <><ConnectionBanner session={session} />{!connectionLabel && readError && showReadError ? <StatusBanner icon={CircleAlert} title={t('无法加载连接器，正在重试…')} description={connector ? t('内容可能不是最新的') : undefined} />
    : !connectionLabel && !readError && ownerCatalog.error && showReadError ? <View testID="connector-catalog-error"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('无法加载连接器目录，正在重试…')} description={t('目录加载后才能填写 Key')} /></View> : null}
    {add.status === 'created' && add.authorization?.status === 'failed' ? <>
      <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(add.authorization.error)} />
      <Button className="mx-4" intent="soft" disabled={offline} onPress={() => void prepareAuthorization(add.id)}><Text>{t('重试发起授权')}</Text></Button>
    </> : null}</>;
  const create = async () => {
    if (add.status === 'editing') session.editorOperations.beginCreationVisit('connector');
    if (!selectConnectorAdd(add, session.editorOperations.get('connector:new'), session.connection !== 'open').canSubmit) return;
    const operationId = newClientId(); const clientId = newClientId(); const stillHere = captureVisit();
    let fields: CreateConnectorInput | undefined;
    try { fields = appId ? undefined : connectorParameterFields(add.status === 'editing' ? add.draft : blankConnectorParameters(mode)); }
    catch (error) { addEvent({ type: 'failed', message: error instanceof Error ? error.message : '连接未完成' }); return; }
    addEvent({ type: 'connect', operationId });
    try {
      const result = await session.editorOperations.run<{ connector: Connector; event?: GatewayEvent | null }>('connector:new', { operationId, resource: 'connector', action: 'save', clientId,
        fields: Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, key === 'headers' || key === 'env' ? true : value])) },
      () => appId ? session.api.connectApp(appId, clientId) : session.api.createConnector(clientId, fields!));
      if (!result) { addEvent({ type: 'failed', operationId, message: '连接未完成' }); return; }
      acceptEvent(result.event);
      if (!stillHere()) return;
      void KeyboardController.dismiss();
      addEvent({ type: 'created', operationId, id: result.connector.id });
      if (result.connector.auth_type === 'oauth') await prepareAuthorization(result.connector.id);
      // connector-auth.AU10: a new catalog key binding opens its Key page in the same visit.
      else if (entry?.auth.type === 'key' && result.connector.auth_type === 'key' && !Object.keys(result.connector.headers ?? {}).length) {
        detailEvent({ type: 'parameters', connector: result.connector, draft: keyParametersFromConnector(result.connector, entry.auth.key.name) });
      }
    } catch (error) {
      const pending = session.editorOperations.get('connector:new');
      if (pending?.operationId === operationId && (pending.status === 'unknown' || pending.reconciled)) return;
      addEvent({ type: 'failed', operationId, ...connectorCreateFailure(error) });
    }
  };
  const probe = async () => {
    if (add.status !== 'editing' || add.draft.mode !== 'remote' || !add.draft.url.trim() || offline) return;
    const key = `${add.draft.url.trim()}:${add.draft.transport}`;
    if (add.probedKey === key) return;
    const probeId = newClientId(); addEvent({ type: 'probe-started', id: probeId, key });
    try { const result = await session.api.probeConnector(add.draft.url.trim(), add.draft.transport === 'auto' ? undefined : add.draft.transport); addEvent({ type: 'probe-finished', id: probeId, key, result }); }
    catch { addEvent({ type: 'probe-finished', id: probeId, key, result: { result: 'failed', transport: add.draft.transport } }); }
  };
  const save = async () => {
    if (!connector || !current().canWrite || detail.status !== 'metadata' && detail.status !== 'parameters') return;
    const operationId = newClientId(); const publish = detail.status === 'parameters' ? result.begin() : undefined;
    detailEvent({ type: 'command', operationId, action: 'save' });
    try {
      const fields: PatchConnectorInput = detail.status === 'metadata' ? connectorMetadataFields(detail.original, detail.name, detail.description, detail.original) : connectorParameterFields(detail.draft, detail.original);
      if (!Object.keys(fields).length) { detailEvent({ type: 'finished', operationId }); return; }
      const saved = await session.editorOperations.run(operationKey, { operationId, resource: 'connector', id: connector.id, action: 'save',
        fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, key === 'headers' || key === 'env' ? true : value])) }, async () => {
        let latest: Connector;
        try { latest = await readConnectorBeforeSave(session, connector.id); }
        catch { throw new GatewayError(409, 'preflight_failed', '无法读取最新连接器资料，请稍后保存'); }
        let checked: PatchConnectorInput;
        try { checked = detail.status === 'metadata' ? connectorMetadataFields(detail.original, detail.name, detail.description, latest) : connectorParameterFields(detail.draft, detail.original, latest); }
        catch (error) { throw new GatewayError(409, 'preflight_conflict', error instanceof Error ? error.message : '保存未完成'); }
        const updated = await session.api.updateConnector(connector.id, checked);
        const test = connector.auth_type === 'key' && !Object.keys(connector.headers ?? {}).length && checked.headers
          ? await session.api.testConnector(connector.id) : undefined;
        return { ...updated, test };
      });
      if (!saved) { detailEvent({ type: 'failed', operationId, message: '保存未完成' }); publish?.('保存未完成'); return; }
      acceptEvent(saved.event); detailEvent({ type: 'finished', operationId });
      if (saved.test && !saved.test.success) publish?.(saved.test.error ?? '连接未完成，请检查连接参数后重试');
    } catch (error) {
      const owner = session.editorOperations.get(operationKey);
      if (owner?.operationId === operationId && (owner.status === 'unknown' || owner.reconciled)) return;
      const message = userErrorMessage(error, error instanceof Error ? error.message : '保存未完成');
      detailEvent({ type: 'failed', operationId, message }); publish?.(message);
    }
  };
  const checkDelete = async () => {
    if (!resourceId || !current().canCheckDelete) return;
    const operationId = newClientId(); const publish = result.begin(); detailEvent({ type: 'check-delete', operationId });
    try { const { agents } = await readConnectorDeletionAgents(session, resourceId); detailEvent({ type: 'checked-delete', operationId, agents }); }
    catch { detailEvent({ type: 'failed', operationId, message: '无法检查删除条件，请检查网关连接后重试。' }); publish('无法检查删除条件，请检查网关连接后重试。'); }
  };
  const command = async (action: 'delete' | 'test' | 'disconnect') => {
    if (action === 'delete' && detail.status !== 'confirm-delete') return;
    if (!resourceId || !(action === 'delete' ? current().canDelete : current().canWrite)) return;
    // Delete failures stay in the confirmation dialog; test / disconnect failures are this visit's result.
    const operationId = newClientId(); const publish = action === 'delete' ? undefined : result.begin();
    detailEvent({ type: 'command', operationId, action });
    try {
      const outcome = await session.editorOperations.run<{ event: GatewayEvent | null } | ConnectorTestResult>(operationKey, { operationId, resource: 'connector', id: resourceId, action }, () => action === 'delete' ? session.api.deleteConnector(resourceId) : action === 'disconnect' ? session.api.clearConnectorKey(resourceId) : session.api.testConnector(resourceId));
      if (!outcome) { detailEvent({ type: 'failed', operationId, message: '操作未完成' }); publish?.('操作未完成'); return; }
      if ('event' in outcome) acceptEvent(outcome.event);
      detailEvent({ type: 'finished', operationId, deleted: action === 'delete', message: action === 'disconnect' ? '密钥已清除，请重新填写后连接' : 'success' in outcome && outcome.success ? '连接成功' : '' });
      if ('success' in outcome && !outcome.success) publish?.(outcome.error ?? '连接未完成，请检查连接参数后重试');
    } catch (error) {
      const owner = session.editorOperations.get(operationKey);
      if (owner?.operationId === operationId && (owner.status === 'unknown' || owner.reconciled)) return;
      const message = error instanceof GatewayError && error.code === 'remote_revocation_failed'
        ? '本地授权已清除，但远端撤销失败，连接器仍保留。请到服务方设置里断开后重试删除。' : '操作未完成，请恢复连接后核对状态';
      detailEvent({ type: 'failed', operationId, message }); publish?.(message);
    }
  };

  const dismiss = useCallback(() => {
    if (resourceId) router.dismissTo('/settings-connectors');
    else if (router.canGoBack()) router.back();
    else router.replace('/connectors/add');
  }, [resourceId]);
  const busy = resourceId ? selected.busy : added.pending;
  const addBanners = <>{banner}
    {added.unknown && showAddedUnknown ? <StatusBanner icon={CircleAlert} title={t('保存结果未确认，恢复连接后自动核对')} /> : null}
    {add.status === 'editing' && add.error ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(add.error, { reason: t(add.reason ?? '') })} /> : null}</>;
  const navigationPanel = isParameters ? 'parameters' : display.status === 'ready' ? display.panel : 'main';
  const back = () => leaveControl.current?.back();
  const authDisabled = offline || auth.selection.busy || selected.unknown || selected.busy || add.status === 'created' && add.authorization?.status === 'checking';
  const authorization = connector?.auth_type === 'oauth' ? <ConnectorOAuthView connector={connector} selection={auth.selection} disabled={authDisabled}
    onStart={() => void auth.start()} onReopen={auth.reopen} onCallback={auth.callback} onSubmit={() => void auth.command('callback')} onCancel={() => void auth.command('cancel-authorization')} /> : null;
  return <>
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !busy && navigationPanel === 'main' }} />
    <OutcomeNavigation gone={selected.gone} recoveredId={!resourceId ? added.recoveredId : undefined} />
    {auth.selection.flow && !auth.selection.busy ? <AuthorizationExpiry key={auth.selection.flow.id} id={auth.selection.flow.id} expiresAt={auth.selection.flow.value.expires_at} expire={auth.expire} /> : null}
    {resourceId ? <ConnectorDetailView connector={connector} keyEntry={keyEntry} state={display} busy={selected.busy} unknown={selected.unknown} canWrite={selected.canWrite} canAuthorize={!authDisabled} canEdit={selected.canEdit && (detail.status !== 'ready' || read.isFetchedAfterMount && read.isSuccess)}
      loading={!connector && !read.error && read.fetchStatus !== 'paused'} banner={banner} authorization={authorization} agents={references.data?.agents} tools={tools.data}
      agentsLoading={!references.data && !references.error && references.fetchStatus !== 'paused'}
      toolsLoading={!tools.data && !tools.error && tools.fetchStatus !== 'paused'}
      onBack={back} onEdit={() => { if (connector && current().canEdit && read.isFetchedAfterMount && read.isSuccess) detailEvent({ type: 'metadata', connector }); }}
      onMetadata={fields => { if (current().canEdit) detailEvent({ type: 'change-metadata', ...fields }); }} onSave={() => void save()} onCancel={() => detailEvent({ type: 'cancel' })} notice={result.notice} onDismissNotice={result.dismiss}
      parametersReady={parametersReady}
      onParameters={() => { if (connector && parametersReady && current().canEdit && read.isFetchedAfterMount && read.isSuccess) detailEvent({ type: 'parameters', connector, draft: parametersOf(connector) }); }} onParameterChange={fields => { if (current().canEdit) detailEvent({ type: 'change-parameters', fields }); }}
      onAgents={() => detailEvent({ type: 'panel', panel: 'agents' })} onTools={() => detailEvent({ type: 'toggle-tools' })}
      onDeleteCheck={() => void checkDelete()} onDelete={() => void command('delete')} onConnect={() => void command('test')} onAuthorize={() => void auth.start()} onDisconnect={() => connector?.auth_type === 'key' ? void command('disconnect') : void auth.command('disconnect')} />
      : appId ? <ConnectorCatalogView entry={entry} missing={!!catalog.data && !entry} loading={!catalog.data && !catalog.error && catalog.fetchStatus !== 'paused'}
        busy={busy} canConnect={added.canSubmit} banner={addBanners} onBack={back} onConnect={() => void create()} />
      : <KeyboardAvoidingView behavior="padding" className="flex-1 bg-muted dark:bg-background"><ScreenBar title={t(mode === 'remote' ? '添加远程连接器' : '添加本地连接器')}
        left={<Button intent="quiet" size="icon" disabled={busy} accessibilityLabel={t('返回')} onPress={back}><Icon as={ChevronLeft} /></Button>} />{addBanners}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
          {add.status !== 'created' ? <ConnectorParameterForm draft={add.draft} disabled={!added.canEdit} onChange={(fields, authTouched) => addEvent({ type: 'change', fields, authTouched })} onProbe={() => void probe()}
            suggestion={add.status === 'editing' ? add.suggestion : undefined} mismatch={add.status === 'editing' && !!add.error} /> : null}
        </ScrollView><Button className="mx-4 mb-6" disabled={!added.canSubmit} onPress={() => void create()}><Text>{t(busy ? '正在连接…' : '连接')}</Text></Button>
      </KeyboardAvoidingView>}
    <ConnectorLeaveBoundary key={resourceId ? selected.leaveIdentity : added.unknown ? `unknown:${outcome?.operationId}` : 'ordinary'} ref={leaveControl} dirty={dirty} busy={busy} unknown={unknown} panel={navigationPanel}
      onMain={() => { if (navigationPanel === 'agents') detailEvent({ type: 'panel', panel: 'main' }); else detailEvent({ type: 'cancel' }); }} dismiss={dismiss} />
  </>;
}
