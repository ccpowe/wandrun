import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StrictMode, useEffect } from 'react';
import { Text } from 'react-native';
import { AgentEditor } from '../src/app/agent-editor';
import { editorScenario, type EditorScenario } from '../src/dev/editor-scenario';
import { SceneProviders } from '../src/dev/scene-providers';
import { GatewayError } from '../src/gateway/api';
import type { EditorIntent } from '../src/gateway/editor-operation';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const tick = async (ms = 200) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
let peer: EditorScenario;
beforeEach(() => { jest.useFakeTimers(); peer = editorScenario('unknown'); });
afterEach(() => { peer.stop(); jest.restoreAllMocks(); jest.useRealTimers(); });
function Other() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Text testID="other-route">其他页面:{id ?? 'no-id'}</Text>;
}
async function openEditor({ creating = false, strict = false, lifecycle }: { creating?: boolean; strict?: boolean; lifecycle?: string[] } = {}) {
  await act(async () => { await peer.start(); });
  function Editor() {
    const { id } = useLocalSearchParams<{ id?: string }>();
    return <><AgentEditor session={peer.session} id={id} /><PortalHost /></>;
  }
  function Probe() {
    useEffect(() => { lifecycle?.push('setup'); return () => { lifecycle?.push('cleanup'); }; }, []);
    return null;
  }
  const scene = <SceneProviders path="/agent-editor" location={creating ? '/agent-editor' : '/agent-editor?id=planner'} routes={{ '/': Other, '/settings': Other }}><Editor /><Probe /></SceneProviders>;
  const view = await render(strict ? <StrictMode>{scene}</StrictMode> : scene);
  await tick();
  return view;
}
async function unresolvedSave() {
  await act(async () => {
    await peer.session.editorOperations.run('agent:planner', { operationId: 'external-save', resource: 'agent', id: 'planner', action: 'save', fields: { name: '待核对' }, baseline: { name: '小万' } },
      () => peer.session.api.updateAgent('planner', { name: '待核对' })).catch(() => {});
  });
  await tick();
}

test('A1 StrictMode 挂载→清理→再挂载保留已核对结果，等待本次读取后仍有提示', async () => {
  await act(async () => { await peer.start(); });
  await unresolvedSave();
  await act(() => peer.recover()); await tick(2000);
  const gate = Promise.withResolvers<void>();
  peer.gateway.overrides['GET /agents/:id'] = async () => { await gate.promise; };
  const lifecycle: string[] = [];
  await openEditor({ strict: true, lifecycle });
  expect(lifecycle.slice(0, 3)).toEqual(['setup', 'cleanup', 'setup']);
  expect(screen.queryByTestId('editor-name')).toBeNull();
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '小万');
  expect(screen.getByRole('alert')).toHaveTextContent('上次修改未保存。');
  expect(peer.session.editorOperations.get('agent:planner')?.operationId).toBe('external-save');
});

test('A1 后续读取失败不卸载已编辑表单或丢失面板草稿', async () => {
  await openEditor();
  await fireEvent.press(screen.getByTestId('editor-prompt')); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '尚未保存的提示词');
  peer.gateway.overrides['GET /agents/:id'] = () => { throw new GatewayError(503, 'unavailable', '读取失败'); };
  await act(() => peer.updateAgent({ name: '远端改名' })); await tick(2000);
  expect(screen.getByTestId('editor-prompt-input')).toHaveProp('value', '尚未保存的提示词');
  expect(screen.getByTestId('editor-prompt-input')).toHaveProp('editable', true);
});

test('T2 未知离开层核对后失效，面板保持、实际草稿采纳一次且新输入不被抹掉', async () => {
  await openEditor();
  await fireEvent.press(screen.getByTestId('editor-prompt')); await tick();
  await unresolvedSave();
  await act(() => router.replace('/settings')); await tick();
  expect(screen.getByTestId('editor-unknown-leave-sheet')).toBeOnTheScreen();
  await act(() => peer.updateAgent({ system_prompt: '核对时实际提示词' }));
  await act(() => peer.recover()); await tick(2000);
  expect(screen.queryByTestId('other-route')).toBeNull();
  expect(screen.queryByTestId('editor-unknown-leave-sheet')).toBeNull();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  expect(screen.getByTestId('editor-prompt-input')).toHaveProp('value', '核对时实际提示词');
  await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '核对后的本地输入');
  await act(() => peer.updateAgent({ system_prompt: '又一次远端更新' })); await tick();
  expect(screen.getByTestId('editor-prompt-input')).toHaveProp('value', '核对后的本地输入');
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '小万');
  await fireEvent.changeText(screen.getByTestId('editor-name'), '');
  await act(() => router.replace({ pathname: '/settings', params: { id: 'fresh' } })); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent('请填写 Agent 名字');
  await act(() => router.replace({ pathname: '/settings', params: { id: 'fresh' } })); await tick();
  expect(screen.getByTestId('editor-leave-sheet')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-leave-discard')); await tick();
  expect(screen.getByTestId('other-route')).toHaveTextContent('其他页面:fresh');
});

test('T2 核对先于页面 catch 完成，迟到 catch 不重新锁定或覆盖新输入', async () => {
  await openEditor();
  const gate = Promise.withResolvers<void>();
  const run = peer.session.editorOperations.run.bind(peer.session.editorOperations);
  jest.spyOn(peer.session.editorOperations, 'run').mockImplementation(async function<T>(key: string, intent: EditorIntent, write: () => Promise<T>): Promise<T | null> {
    try { return await run(key, intent, write); }
    catch (error) { await gate.promise; throw error; }
  });
  await fireEvent.changeText(screen.getByTestId('editor-name'), '待核对名字');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', false);
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
  await fireEvent.changeText(screen.getByTestId('editor-name'), '核对后的新输入');
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '核对后的新输入');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
  expect(screen.queryByTestId('editor-unknown-leave-sheet')).toBeNull();
});

test('B3 失焦后迟到保存成功不导航其他页面，返回时看到实际保存值', async () => {
  const gate = Promise.withResolvers<void>();
  peer.gateway.overrides['PATCH /agents/:id'] = async (_, respond) => { await gate.promise; return respond(); };
  await openEditor();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '迟到但保存成功');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  await act(() => router.push('/settings')); await tick();
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('other-route')).toHaveTextContent('其他页面:no-id');
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '迟到但保存成功');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
});

test('B5 直接新建路由忽略进入前已解决的创建，不消费资源别名', async () => {
  peer.stop(); peer = editorScenario('unknown-applied');
  await act(async () => { await peer.start(); });
  await act(async () => {
    await peer.session.editorOperations.run('agent:new', { operationId: 'old-create', resource: 'agent', action: 'save', clientId: 'old-client', fields: { name: '旧创建' } },
      () => peer.session.api.createAgent('old-client', { name: '旧创建', avatar: 0, description: '已完成', system_prompt: '提示词', code_mode: true, environment: 'local', skills: [], workers: [], mcp_servers: [], searchable_mcp_servers: [] })).catch(() => {});
  });
  await act(() => peer.recover()); await tick(2000);
  const created = peer.session.editorOperations.get('agent:new')!;
  expect(created.reconciled).toBe(true);
  await openEditor({ creating: true, strict: true });
  expect(screen.getByText('新建 Agent')).toBeOnTheScreen();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
  expect(peer.session.editorOperations.get(`agent:${created.id}`)?.operationId).toBe('old-create');
});

test('B5 附着未确认创建失焦后核对不改其他页参数，重新聚焦才精确交接', async () => {
  peer.stop(); peer = editorScenario('unknown-applied');
  await openEditor({ creating: true });
  await fireEvent.changeText(screen.getByTestId('editor-name'), '新建交接');
  await fireEvent.changeText(screen.getByTestId('editor-description'), '交接说明');
  await fireEvent.press(screen.getByTestId('editor-prompt')); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '交接提示词');
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  const operationId = peer.session.editorOperations.get('agent:new')!.operationId;
  await act(() => router.push('/settings')); await tick();
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId('other-route')).toHaveTextContent('其他页面:no-id');
  expect(peer.session.editorOperations.get('agent:new')?.operationId).toBe(operationId);
  await act(() => router.back()); await tick();
  expect(screen.getByText('编辑 Agent')).toBeOnTheScreen();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '新建交接');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
  expect(peer.session.editorOperations.get('agent:new')).toBeUndefined();
  const created = peer.gateway.state.agents.find(row => row.name === '新建交接')!;
  expect(peer.session.editorOperations.get(`agent:${created.id}`)?.operationId).toBe(operationId);
});

test('A1 T2 本次详情未就绪也能确认未知离开，核对后旧目的地作废', async () => {
  await act(async () => { await peer.start(); });
  await unresolvedSave();
  const gate = Promise.withResolvers<void>();
  peer.gateway.overrides['GET /agents/:id'] = async () => { await gate.promise; };
  await openEditor();
  expect(screen.queryByTestId('editor-name')).toBeNull();
  await act(() => router.replace('/settings')); await tick();
  expect(screen.getByTestId('editor-unknown-leave-sheet')).toBeOnTheScreen();
  await act(() => { peer.recover(); gate.resolve(); }); await tick(2000);
  expect(screen.queryByTestId('other-route')).toBeNull();
  expect(screen.queryByTestId('editor-unknown-leave-sheet')).toBeNull();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '小万');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
});

for (const stage of ['pending', 'unknown'] as const) test(`A6 墓碑优先于 ${stage} 和离开层，迟到应答不能恢复旧页`, async () => {
  const gate = Promise.withResolvers<void>();
  if (stage === 'pending') peer.gateway.overrides['PATCH /agents/:id'] = async (_, respond) => {
    const response = await respond();
    await gate.promise;
    return response;
  };
  await openEditor();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '稍后返回的保存');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  if (stage === 'unknown') {
    await act(() => router.replace('/settings')); await tick();
    expect(screen.getByTestId('editor-unknown-leave-sheet')).toBeOnTheScreen();
  }
  await act(() => peer.removeAgent()); await tick();
  expect(screen.getByTestId('other-route')).toHaveTextContent('其他页面:no-id');
  expect(screen.queryByTestId('editor-unknown-leave-sheet')).toBeNull();
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('other-route')).toHaveTextContent('其他页面:no-id');
  expect(screen.queryByTestId('editor-name')).toBeNull();
});
