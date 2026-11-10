import { onlineManager, QueryObserver } from '@tanstack/react-query';
import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as agentStories from '../src/dev/agent-editor.stories';
import * as scheduleStories from '../src/dev/schedule-editor.stories';
import { editorScenario } from '../src/dev/editor-scenario';
import { jsonResponse } from '../src/dev/fake-gateway';
import { GatewayError } from '../src/gateway/api';
import { gatewayQueryClient, scheduleDetailOptions } from '../src/lib/gateway-queries';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const Agent = composeStories(agentStories);
const Schedule = composeStories(scheduleStories);
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const tick = async (ms = 200) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const fillNew = async () => {
  await fireEvent.changeText(screen.getByTestId('editor-name'), '新伙伴');
  await fireEvent.changeText(screen.getByTestId('editor-description'), '查阅技术资料');
  await fireEvent.press(screen.getByTestId('editor-prompt')); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '给出原始来源与可验证结论。');
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
};

for (const schedule of [false, true]) {
  const prefix = schedule ? 'schedule' : 'editor';
  test(`${schedule ? 'schedule-editor.B5' : 'agent-editor.B4'} 原生返回自动保存未确认，再次返回遵守各页离开规则`, async () => {
    const peer = editorScenario('unknown');
    const Story = schedule ? Schedule.B5 : Agent.B4;
    await render(<Story scenario={peer} />); await tick();
    await fireEvent.changeText(screen.getByTestId(`${prefix}-name`), '未确认草稿');
    await act(() => router.back()); await tick();
    expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
    expect(screen.getByTestId(`${prefix}-name`)).toHaveProp('editable', false);
    await act(() => router.back()); await tick();
    expect(screen.getByTestId('editor-unknown-leave-sheet')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
    expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
    expect(screen.queryByTestId(`${prefix}-save`)).toBeNull();
  });
}

test('agent-editor.B5 T2 未确认新建不重放，离开不保留提交内容，重入仍只读', async () => {
  const peer = editorScenario('unknown');
  let writes = 0;
  const original = peer.gateway.overrides['POST /agents']!;
  peer.gateway.overrides['POST /agents'] = (context, respond) => { writes++; return original(context, respond); };
  await render(<Agent.B5 scenario={peer} />); await tick(); await fillNew();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', false);
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(writes).toBe(1);
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  await fireEvent.press(screen.getByTestId('agents-add')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', false);
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId('editor-save')).toBeDisabled();
  expect(writes).toBe(1);
});

test('agent-editor.B5 B6 精确创建回执恢复为已有项编辑，不再次创建', async () => {
  const peer = editorScenario('unknown-applied');
  await render(<Agent.B5Applied scenario={peer} />); await tick(); await fillNew();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', false);
  const created = peer.gateway.state.agents.find(row => row.name === '新伙伴')!;
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByText('编辑 Agent')).toBeOnTheScreen();
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
  expect(screen.getByText('已核对，操作已完成。')).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '已核对后改名');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(peer.gateway.state.agentDetails.get(created.id)?.name).toBe('已核对后改名');
  expect(peer.gateway.state.agents.map(row => row.id)).toEqual(['planner', 'researcher', created.id]);
});

test('agent-editor.B5 未确认新建重入仍只读，后台确认后再次点＋是全新空白表单', async () => {
  const peer = editorScenario('unknown-applied');
  await render(<Agent.B5Applied scenario={peer} />); await tick(); await fillNew();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
  await fireEvent.press(screen.getByTestId('agents-add')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', false);
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent(/上次保存结果未确认，正在核对/);
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId(`agent-row-${peer.gateway.state.agents.find(agent => agent.name === '新伙伴')!.id}`)).toBeOnTheScreen();
  expect(screen.queryByTestId('editor-name')).toBeNull();
  await fireEvent.press(screen.getByTestId('agents-add')); await tick();
  expect(screen.getByText('新建 Agent')).toBeOnTheScreen();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
});

test('agent-editor.A3 B6 创建返回目录追加末尾，不自动开聊天', async () => {
  const peer = editorScenario();
  await render(<Agent.A3 scenario={peer} />); await tick(); await fillNew();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  const created = peer.gateway.state.agents.at(-1)!;
  expect(screen.getByText('新伙伴')).toBeOnTheScreen();
  expect(screen.queryByTestId('editor-save')).toBeNull();
  expect(peer.gateway.state.conversations.some(row => row.agent_id === created.id)).toBe(false);
});

for (const create of [false, true]) {
  test(`agent-editor.B4 B5 模型目录写入前明确拒绝后可修正并再次提交：${create ? '创建' : '编辑'}`, async () => {
    const peer = editorScenario();
    let available = false;
    const refusal = '模型目录暂不可用，尚未写入';
    peer.gateway.overrides[create ? 'POST /agents' : 'PATCH /agents/:id'] = () =>
      available ? undefined : jsonResponse({ error: { code: 'model_catalog_unavailable', message: refusal } }, 503);
    const Story = create ? Agent.A3 : Agent.A2;
    await render(<Story scenario={peer} />); await tick();
    if (create) await fillNew();
    else {
      await fireEvent.changeText(screen.getByTestId('editor-name'), '新伙伴');
      await fireEvent(screen.getByTestId('editor-reasoning-slider'), 'valueChange', 1);
    }
    await fireEvent.press(screen.getByTestId('editor-save')); await tick();
    expect(screen.getByRole('alert')).toHaveTextContent(refusal);
    expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
    expect(screen.getByTestId('editor-save')).toBeEnabled();
    available = true;
    await fireEvent.press(screen.getByTestId('editor-save')); await tick();
    expect(screen.queryByTestId('editor-save')).toBeNull();
    expect(screen.getByText('新伙伴')).toBeOnTheScreen();
  });
}

test('agent-editor.B2 校验横幅指出名字 / 提示词 / 说明问题，修正后继续校验', async () => {
  await render(<Agent.A3 />); await tick();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent('请填写 Agent 名字');
  await fireEvent.changeText(screen.getByTestId('editor-name'), '新伙伴');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent('请填写 Agent 提示词');
  await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '提示词');
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent('请填写 Agent 说明');
});

test('agent-editor.A2 F1 T1 成员随父表单返回自动保存，子页完成不直写', async () => {
  const peer = editorScenario();
  await render(<Agent.A2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-members')); await tick();
  await fireEvent.press(screen.getByTestId('editor-member-researcher'));
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.workers).toEqual([]);
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.workers).toEqual(['researcher']);
});

test('agent-editor.F1 F2 F3 缺失成员可移除，搜索零结果不冒充空目录', async () => {
  const peer = editorScenario('missing-selections');
  await render(<Agent.E1 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-members')); await tick();
  expect(screen.getByText('成员资料暂不可用')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-member-missing-agent'));
  await fireEvent.changeText(screen.getByTestId('editor-member-search'), 'does-not-exist');
  expect(screen.getByText('没有匹配的 Agent')).toBeOnTheScreen();
  expect(peer.gateway.state.agentDetails.get('planner')!.workers).toEqual(['researcher', 'missing-agent']);
});

test('agent-editor.C5 C6 Fast 与强度分开保存；旧网关不抹掉已存 Fast', async () => {
  const peer = editorScenario();
  const view = await render(<Agent.A2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-fast-mode'));
  expect(peer.gateway.state.agentDetails.get('planner')!.fast_mode).toBe(false);
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.fast_mode).toBe(true);
  expect(peer.gateway.state.agentDetails.get('planner')!.reasoning_effort).toBe('medium');
  await view.unmount();
  const old = editorScenario('fast-unsupported');
  old.gateway.state.agentDetails.get('planner')!.fast_mode = true;
  await render(<Agent.C6 scenario={old} />); await tick();
  expect(screen.getByTestId('editor-fast-mode')).toBeDisabled();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '只改名字');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(old.gateway.state.agentDetails.get('planner')!.fast_mode).toBe(true);
});

test('agent-editor.D2 D3 D4 机器部分失败仍可选择，恢复目录不覆盖草稿', async () => {
  const peer = editorScenario('environment-partial');
  await render(<Agent.D2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-environment')); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载机器列表，正在重试…')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-environment-cloud-b'));
  await act(() => peer.recover()); await tick(1500);
  expect(screen.getByTestId('editor-environment-cloud-b')).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.environment).toBe('cloud-a');
  await fireEvent.press(screen.getByTestId('environment-switch-confirm')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.environment).toBe('cloud-b');
});

test('agent-editor.E1 E2 E3 E4 E5 技能失效项仅取消；连接器两种模式互斥并随表单提交', async () => {
  const peer = editorScenario('missing-selections');
  await render(<Agent.E1 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-skills')); await tick();
  await fireEvent.press(screen.getByTestId('editor-skill-research'));
  await fireEvent.press(screen.getByTestId('editor-skill-broken-skill'));
  expect(screen.queryByTestId('editor-skill-broken-skill')).toBeNull();
  await fireEvent.press(screen.getByTestId('editor-skill-missing-skill'));
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  await fireEvent.press(screen.getByTestId('editor-connectors')); await tick();
  await fireEvent.press(screen.getByTestId('editor-connector-missing-connector'));
  await fireEvent.press(screen.getByTestId('editor-connector-docs'));
  await fireEvent.press(screen.getByTestId('editor-connector-search-docs'));
  await fireEvent.press(screen.getByTestId('editor-connector-no-description'));
  expect(screen.getByTestId('editor-connector-search-no-description')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.searchable_mcp_servers).toEqual([]);
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  const saved = peer.gateway.state.agentDetails.get('planner')!;
  expect(saved.skills).toEqual(['research']);
  expect(saved.searchable_mcp_servers).toEqual(['docs']);
  expect(saved.mcp_servers).toEqual(['no-description']);
});

test('agent-editor.C2 E2 E5 目录读取失败自动恢复，旧草稿不变且无手动重试', async () => {
  const peer = editorScenario('catalog-failure');
  await render(<Agent.C2 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '保留草稿');
  await fireEvent.press(screen.getByTestId('editor-skills')); await tick();
  expect(screen.queryByText('重试')).toBeNull();
  expect(screen.queryByText('没有可用技能')).toBeNull();
  await act(() => peer.recover()); await tick(3000);
  expect(screen.getByTestId('editor-skill-research')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '保留草稿');
});

test('agent-editor.G1 G2 G3 G4 能力只读详情、外部撤销关闭详情，读取错误自动恢复', async () => {
  const peer = editorScenario('capabilities');
  const view = await render(<Agent.G2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-system-capabilities')); await tick();
  await fireEvent.press(screen.getByTestId('capability-files')); await tick();
  expect(screen.getByText('read_file')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('关闭')); await tick();
  expect(screen.queryByTestId('capability-sheet')).toBeNull();
  await fireEvent.press(screen.getByTestId('capability-files')); await tick();
  await act(() => peer.revokeCapability()); await tick();
  expect(screen.queryByTestId('capability-sheet')).toBeNull();
  expect(screen.getByTestId('capability-unavailable-files')).toBeOnTheScreen();
  await view.unmount();
  const failed = editorScenario('capabilities-failure');
  await render(<Agent.G4 scenario={failed} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-system-capabilities')); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载系统能力，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('重试')).toBeNull();
  await act(() => failed.recover()); await tick(2000);
  expect(screen.getByTestId('capability-files')).toBeOnTheScreen();
});

test('agent-editor.A6 H2 H3 H5 团队阻止删除、取消保留对象、明确删除失败留层', async () => {
  const blocked = await render(<Agent.H2 />); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  expect(screen.getByText('现在不能删除')).toBeOnTheScreen();
  expect(screen.queryByTestId('editor-delete-confirm')).toBeNull();
  await blocked.unmount();
  const peer = editorScenario('delete-failure');
  await render(<Agent.H5 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-cancel')); await tick();
  expect(peer.gateway.state.agentDetails.has('planner')).toBe(true);
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-confirm')); await tick();
  expect(screen.getByTestId('editor-delete-confirm')).toBeOnTheScreen();
  expect(screen.getByText('当前操作不能删除，请稍后重试。')).toBeOnTheScreen();
  expect(peer.gateway.state.agentDetails.has('planner')).toBe(true);
});

test('schedule-editor.B6 B7 T1 T2 外部更新不覆盖草稿，显式重载先确认且失败保留文字', async () => {
  const peer = editorScenario('external-update');
  await render(<Schedule.B6 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '本地草稿');
  await act(() => peer.updateSchedule('服务器名称')); await tick();
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '本地草稿');
  await fireEvent.press(screen.getByTestId('schedule-reload')); await tick();
  expect(screen.getByText('重新载入并舍弃草稿？')).toBeOnTheScreen();
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '本地草稿');
  await fireEvent.press(screen.getByText('继续编辑')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-reload')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-reload-confirm')); await tick();
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '服务器名称');
  expect(screen.queryByTestId('schedule-reload')).toBeNull();
});

test('schedule-editor.B3 B4 已结束单次禁用启用，校验横幅指出名称问题', async () => {
  const view = await render(<Schedule.B3 />); await tick();
  expect(screen.getByTestId('schedule-enabled')).toBeDisabled();
  expect(screen.getByTestId('schedule-next')).toHaveTextContent('已结束');
  await view.unmount();
  await render(<Schedule.A6 />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '');
  await fireEvent.press(screen.getByTestId('schedule-save')); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent(/请填写名称/);
});

test('schedule-editor.C1 C2 C3 C4 C5 C6 运行记录分页、无对话说明与打开关联对话', async () => {
  await render(<Schedule.C6 />); await tick();
  expect(screen.getByTestId('schedule-run-25')).toHaveTextContent(/未运行/);
  expect(screen.getByTestId('schedule-run-6')).toHaveTextContent(/已完成/);
  expect(screen.queryByTestId('schedule-run-1')).toBeNull();
  expect(screen.queryByText('对话已删除')).toBeNull();
  await fireEvent.press(screen.getByTestId('schedule-runs-more')); await tick();
  expect(screen.getByTestId('schedule-run-1')).toBeEnabled();
  expect(screen.queryByTestId('schedule-runs-more')).toBeNull();
  await fireEvent.press(screen.getByTestId('schedule-run-1')); await tick(1000);
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新闻简报运行');
});

test('schedule-editor.D1 D3 D4 删除取消保留对象，明确失败留层，恢复后显式再删', async () => {
  const peer = editorScenario('delete-failure');
  await render(<Schedule.D4 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('schedule-delete')); await tick();
  await fireEvent.press(screen.getByText('取消')); await tick();
  expect(peer.gateway.state.schedules.some(row => row.id === 'morning')).toBe(true);
  await fireEvent.press(screen.getByTestId('schedule-delete')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-delete-confirm')); await tick();
  expect(screen.getByTestId('schedule-delete-error')).toHaveTextContent('当前操作不能删除，请稍后重试。');
  await act(() => peer.recover()); await tick(1000);
  await fireEvent.press(screen.getByTestId('schedule-delete-confirm')); await tick();
  expect(screen.getByText('还没有定时')).toBeOnTheScreen();
  expect(peer.gateway.state.conversations.some(row => row.id === 'run-chat')).toBe(true);
});

test('agent-editor.A6 并发保留其他字段，同字段后保存覆盖，不自动改草稿', async () => {
  const peer = editorScenario();
  await render(<Agent.A2 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '本地改名');
  await act(() => peer.updateAgent({ name: '别处改名', description: '别处的新说明' })); await tick();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '本地改名');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.name).toBe('本地改名');
  expect(peer.gateway.state.agentDetails.get('planner')!.description).toBe('别处的新说明');
});

test('schedule-editor.B7 T2 重载失败保留草稿，重试不能盖掉失败后继续输入的新文字', async () => {
  const peer = editorScenario('external-update');
  await render(<Schedule.B6 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '本地草稿');
  await act(() => peer.updateSchedule('服务器名称')); await tick();
  peer.gateway.overrides['GET /schedules/:id'] = () => new Response(JSON.stringify({ error: { code: 'unavailable', message: '暂不可用' } }), { status: 503 });
  await fireEvent.press(screen.getByTestId('schedule-reload')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-reload-confirm')); await tick();
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '本地草稿');
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '失败后继续编辑');
  delete peer.gateway.overrides['GET /schedules/:id'];
  await tick(2000);
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '失败后继续编辑');
  expect(screen.getByTestId('schedule-reload')).toBeOnTheScreen();
});

test('schedule-editor.C5 记录失败不是空态，恢复后自动显示记录且不丢表单草稿', async () => {
  const peer = editorScenario('runs-failure');
  peer.gateway.state.scheduleRuns.set('morning', [{ id: 1, schedule_id: 'morning', scheduled_at: 1, started_at: null, finished_at: null, status: 'failed', reason: '执行环境不可用', conversation_id: null, name: '简报', content: '整理新闻', missed_before: null }]);
  await render(<Schedule.C5 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '仍在编辑');
  expect(screen.queryByText('暂无运行记录')).toBeNull();
  await tick(3000);
  expect(screen.getByText('无法加载运行记录，正在重试…')).toBeOnTheScreen();
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId('schedule-run-1')).toHaveTextContent(/执行环境不可用/);
  expect(screen.getByTestId('schedule-run-1')).toHaveTextContent(/没有可打开的对话/);
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '仍在编辑');
});

for (const schedule of [false, true]) test(`${schedule ? 'schedule-editor.D4' : 'agent-editor.H5'} 删除未确认关闭确认层，离开后不重放`, async () => {
  const peer = editorScenario('delete-unknown');
  const Story = schedule ? Schedule.D4Unknown : Agent.H5Unknown;
  const prefix = schedule ? 'schedule' : 'editor';
  let deletes = 0;
  const endpoint = schedule ? 'DELETE /schedules/:id' : 'DELETE /agents/:id';
  const original = peer.gateway.overrides[endpoint]!;
  peer.gateway.overrides[endpoint] = (context, respond) => { deletes++; return original(context, respond); };
  await render(<Story scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId(`${prefix}-delete`)); await tick();
  await fireEvent.press(screen.getByTestId(`${prefix}-delete-confirm`)); await tick();
  expect(screen.queryByTestId(`${prefix}-delete-confirm`)).toBeNull();
  expect(screen.getByTestId(`${prefix}-name`)).toHaveProp('editable', false);
  await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
  await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  await act(() => peer.recover()); await tick(2000);
  expect(deletes).toBe(1);
  if (schedule) await fireEvent.press(screen.getByText('每日新闻简报'));
  else await fireEvent.press(screen.getByLabelText(/编辑.*小万/));
  await tick();
  expect(screen.getByTestId(`${prefix}-name`)).toHaveProp('editable', true);
  expect(screen.queryByTestId(`${prefix}-delete-confirm`)).toBeNull();
  await fireEvent.changeText(screen.getByTestId(`${prefix}-name`), '核对后可继续保存');
  await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
  expect(schedule ? peer.gateway.state.schedules[0].name : peer.gateway.state.agentDetails.get('planner')!.name).toBe('核对后可继续保存');
});

test('agent-editor.B4 核对后显示网关当前字段，不恢复未确认草稿或覆盖远端', async () => {
  const peer = editorScenario('unknown');
  await render(<Agent.B4 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '我的改名');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  await act(() => peer.updateAgent({ description: '另一设备更新的说明' }));
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '小万');
  expect(screen.getByTestId('editor-description')).toHaveProp('value', '另一设备更新的说明');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(peer.gateway.state.agentDetails.get('planner')!.description).toBe('另一设备更新的说明');
});

for (const schedule of [false, true]) test(`${schedule ? 'schedule-editor.T4' : 'agent-editor.T2'} 核对后放弃的草稿不在下一次进入复活`, async () => {
  const peer = editorScenario('unknown');
  const Story = schedule ? Schedule.B5 : Agent.B4;
  const prefix = schedule ? 'schedule' : 'editor';
  await render(<Story scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId(`${prefix}-name`), '明确放弃的文字');
  await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
  await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
  await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
  await act(() => peer.recover()); await tick(2000);
  if (schedule) await fireEvent.press(screen.getByText('每日新闻简报'));
  else await fireEvent.press(screen.getByLabelText(/编辑.*小万/));
  await tick();
  await fireEvent.changeText(screen.getByTestId(`${prefix}-name`), '');
  await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
  await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
  await fireEvent.press(screen.getByTestId('editor-leave-discard')); await tick();
  if (schedule) await fireEvent.press(screen.getByText('每日新闻简报'));
  else await fireEvent.press(screen.getByLabelText(/编辑.*小万/));
  await tick();
  expect(screen.getByTestId(`${prefix}-name`)).toHaveProp('value', schedule ? '每日新闻简报' : '小万');
});

test('schedule-editor.C5 C6 T3 第三页失败自动重读原游标，已展示两页不缩回首屏', async () => {
  const peer = editorScenario('runs-many');
  const existing = peer.gateway.state.scheduleRuns.get('morning')!;
  peer.gateway.state.scheduleRuns.set('morning', [...Array.from({ length: 20 }, (_, index) => ({ ...existing[0], id: 45 - index })), ...existing]);
  let fail = false;
  peer.gateway.overrides['GET /schedules/:id/runs'] = ({ url }) => {
    if (fail && url.searchParams.get('before') === '6') return new Response(JSON.stringify({ error: { code: 'unavailable', message: '读取失败' } }), { status: 503 });
  };
  await render(<Schedule.C6 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('schedule-runs-more')); await tick();
  expect(screen.getByTestId('schedule-run-45')).toBeOnTheScreen();
  expect(screen.getByTestId('schedule-run-6')).toBeOnTheScreen();
  fail = true;
  await fireEvent.press(screen.getByTestId('schedule-runs-more')); await tick();
  expect(screen.getByTestId('schedule-run-45')).toBeOnTheScreen();
  expect(screen.getByTestId('schedule-run-6')).toBeOnTheScreen();
  fail = false; await tick(1000);
  expect(screen.getByTestId('schedule-run-45')).toBeOnTheScreen();
  expect(screen.getByTestId('schedule-run-6')).toBeOnTheScreen();
  expect(screen.getByTestId('schedule-run-1')).toBeOnTheScreen();
  expect(screen.queryByTestId('schedule-runs-more')).toBeNull();
});

test('schedule-editor.A6 自动保存去运行对话，失败后放弃实际回退，再次原生返回仍自动保存', async () => {
  const peer = editorScenario('runs');
  await render(<Schedule.C2 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '保存后去看记录');
  await fireEvent.press(screen.getByTestId('schedule-run-1')); await tick();
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新闻简报运行');
  await act(() => router.back()); await tick();
  const save = peer.session.api.updateSchedule.bind(peer.session.api);
  const rejected = jest.spyOn(peer.session.api, 'updateSchedule').mockRejectedValue(new GatewayError(400, 'invalid_request', '明确拒绝'));
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '这次放弃');
  await fireEvent.press(screen.getByTestId('schedule-run-1')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-run-1')); await tick();
  await fireEvent.press(screen.getByTestId('editor-leave-discard')); await tick();
  await act(() => router.back()); await tick();
  rejected.mockImplementation(save);
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '保存后去看记录');
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '再次有修改');
  await act(() => router.back()); await tick();
  expect(screen.queryByTestId('schedule-save')).toBeNull();
  expect(peer.gateway.state.schedules[0].name).toBe('再次有修改');
});

for (const schedule of [false, true]) test(`${schedule ? 'schedule-editor.A3' : 'agent-editor.A1'} 当前读取错误不能被历史核对提示遮住`, async () => {
  const peer = editorScenario('unknown');
  const Story = schedule ? Schedule.B5 : Agent.B4;
  const prefix = schedule ? 'schedule' : 'editor';
  await render(<Story scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId(`${prefix}-name`), '待核对');
  await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  const endpoint = schedule ? 'GET /schedules/:id/runs' : 'GET /agents/:id';
  peer.gateway.overrides[endpoint] = () => new Response(JSON.stringify({ error: { code: 'unavailable', message: '读取失败' } }), { status: 503 });
  await act(() => peer.recover()); await tick(2000);
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent(schedule ? /无法加载运行记录/ : /无法加载 Agent/);
  expect(screen.getByTestId(`${prefix}-name`)).toHaveProp('value', schedule ? '每日新闻简报' : '小万');
});

test('agent-editor.F2 F4 G2 加载失败不冒充空目录，成功空态明确且可自动恢复', async () => {
  const peer = editorScenario('member-failure');
  const failed = await render(<Agent.F4 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-members')); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载成员，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('没有其他 Agent')).toBeNull();
  await act(() => peer.recover()); await tick(2000);
  expect(screen.getByTestId('editor-member-researcher')).toBeOnTheScreen();
  await failed.unmount();
  const empty = await render(<Agent.F2Empty />); await tick();
  await fireEvent.press(screen.getByTestId('editor-members')); await tick();
  expect(screen.getByText('没有其他 Agent')).toBeOnTheScreen();
  await empty.unmount();
  await render(<Agent.G2Empty />); await tick();
  await fireEvent.press(screen.getByTestId('editor-system-capabilities')); await tick();
  expect(screen.getByText('没有系统能力')).toBeOnTheScreen();
});

test('agent-editor.H2 T3 预检查通过后网关拒绝删除，确认层转为阻止原因', async () => {
  const peer = editorScenario('delete-conflict');
  await render(<Agent.H2Conflict scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  expect(screen.getByTestId('editor-delete-confirm')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-delete-confirm')); await tick();
  expect(screen.getByTestId('editor-delete-blocked-ack')).toBeOnTheScreen();
  expect(screen.queryByTestId('editor-delete-confirm')).toBeNull();
  expect(peer.gateway.state.agentDetails.has('planner')).toBe(true);
});

test('schedule-editor.T3 分页旧响应不能追加到新 revision，重新加载仍不漏中间记录', async () => {
  const peer = editorScenario('runs-many');
  const held = Promise.withResolvers<void>();
  peer.gateway.overrides['GET /schedules/:id/runs'] = async ({ url }, respond) => {
    if (url.searchParams.has('before')) { const response = await respond(); await held.promise; return response; }
  };
  await render(<Schedule.C6 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('schedule-runs-more')); await tick();
  const rows = peer.gateway.state.scheduleRuns.get('morning')!;
  rows.unshift({ ...rows[0], id: 26 });
  await act(() => peer.updateSchedule('新的已保存名称')); await tick();
  await act(() => held.resolve()); await tick();
  expect(screen.getByTestId('schedule-run-26')).toBeOnTheScreen();
  expect(screen.queryByTestId('schedule-run-1')).toBeNull();
  await fireEvent.press(screen.getByTestId('schedule-runs-more')); await tick();
  expect(screen.getByTestId('schedule-run-6')).toBeOnTheScreen();
  expect(screen.getByTestId('schedule-run-1')).toBeOnTheScreen();
});

test('agent-editor.E2 慢速技能重读只发一次，不因旧错误取消在途请求', async () => {
  const peer = editorScenario();
  const held = Promise.withResolvers<void>();
  let reads = 0;
  await render(<Agent.A2 scenario={peer} />); await tick(300);
  peer.gateway.overrides['GET /skills'] = async (_, respond) => {
    if (++reads === 1) return new Response(JSON.stringify({ error: { code: 'unavailable', message: '暂不可用' } }), { status: 503 });
    await held.promise; return respond();
  };
  await act(() => peer.session.skillChanged(null)); await tick();
  await fireEvent.press(screen.getByTestId('editor-skills')); await tick();
  await tick(10_000);
  expect(reads).toBe(2);
  expect(screen.getByText('无法加载技能，正在重试…')).toBeOnTheScreen();
  await act(() => held.resolve()); await tick();
  expect(screen.getByTestId('editor-skill-research')).toBeOnTheScreen();
  expect(screen.queryByText('无法加载技能，正在重试…')).toBeNull();
});

test('agent-editor.D2 慢速分页保留失败横幅与已知机器，不启动重叠读取', async () => {
  const peer = editorScenario('environment-partial');
  const held = Promise.withResolvers<void>();
  let pages = 0;
  peer.gateway.overrides['GET /execution-environments'] = async ({ url }) => {
    if (!url.searchParams.has('cursor')) return new Response(JSON.stringify({ environments: peer.gateway.state.environments, next_cursor: 'more' }), { status: 200 });
    if (++pages === 1) return new Response(JSON.stringify({ error: { code: 'unavailable', message: '暂不可用' } }), { status: 503 });
    await held.promise; return new Response(JSON.stringify({ environments: [], next_cursor: null }), { status: 200 });
  };
  await render(<Agent.D2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('editor-environment')); await tick();
  await tick(10_000);
  expect(pages).toBe(2);
  expect(screen.getByText('无法加载机器列表，正在重试…')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-environment-cloud-b'));
  await act(() => held.resolve()); await tick();
  expect(screen.getByTestId('editor-environment-cloud-b')).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
  expect(screen.queryByText('无法加载机器列表，正在重试…')).toBeNull();
});

test('agent-editor.T2 核对在未知离开确认期间完成时关闭确认，不冒出未保存层', async () => {
  const peer = editorScenario('unknown');
  await render(<Agent.B4 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '待核对');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  expect(screen.getByTestId('editor-unknown-leave-sheet')).toBeOnTheScreen();
  await act(() => peer.recover()); await tick(2000);
  expect(screen.queryByTestId('editor-unknown-leave-sheet')).toBeNull();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  expect(screen.getByTestId('editor-name')).toHaveProp('value', '小万');
  expect(screen.getByTestId('editor-name')).toHaveProp('editable', true);
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  expect(screen.getByTestId('agents-add')).toBeOnTheScreen();
});

test('agent-editor.H1 删除预检查读取最新约束，不因 Query 联网判断暂停而锁住页面', async () => {
  const peer = editorScenario();
  await render(<Agent.H3 scenario={peer} />); await tick();
  try {
    onlineManager.setOnline(false);
    peer.gateway.state.agentDetails.get('planner')!.member_of = ['researcher'];
    await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
    expect(screen.getByTestId('editor-delete-blocked-ack')).toBeOnTheScreen();
    expect(screen.getByText('研究员。先在它们的“团队成员”里移除它。')).toBeOnTheScreen();
  } finally { onlineManager.setOnline(true); await tick(); }
});

test('schedule-editor.T5 保存在途 push 运行对话，迟到成功不执行旧返回，回到编辑器基线已更新', async () => {
  const peer = editorScenario('runs');
  const gate = Promise.withResolvers<void>();
  peer.gateway.overrides['PATCH /schedules/:id'] = async () => { await gate.promise; };
  await render(<Schedule.C2 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '失焦前提交');
  await fireEvent.press(screen.getByTestId('schedule-save')); await tick();
  await act(() => router.push('/chat?id=run-chat')); await tick();
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新闻简报运行');
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新闻简报运行');
  expect(peer.gateway.state.schedules[0].name).toBe('失焦前提交');
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', '失焦前提交');
});

for (const continuedEditing of [false, true]) test(`schedule-editor.B7 A6 重载失败自动恢复读取和返回保存，${continuedEditing ? '继续输入' : '不再输入'}`, async () => {
  const peer = editorScenario('external-update');
  await render(<Schedule.B6 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '本地草稿');
  await act(() => peer.updateSchedule('服务器名称')); await tick();
  let available = false, reads = 0;
  peer.gateway.overrides['GET /schedules/:id'] = () => {
    reads++;
    if (!available) return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
  };
  await fireEvent.press(screen.getByTestId('schedule-reload')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-reload-confirm')); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent(/无法加载定时/);
  if (continuedEditing) await fireEvent.changeText(screen.getByTestId('schedule-name'), '失败后继续输入');
  const beforeRecovery = reads;
  available = true;
  await tick(5000);
  expect(reads).toBeGreaterThan(beforeRecovery);
  expect(screen.queryByRole('alert')).toBeNull();
  const name = continuedEditing ? '失败后继续输入' : '本地草稿';
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', name);
  await fireEvent.press(screen.getByTestId('schedule-back')); await tick();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  expect(screen.queryByTestId('schedule-name')).toBeNull();
  expect(peer.gateway.state.schedules[0].name).toBe(name);
});

for (const [action, result] of [['save', 'current'], ['save', 'saved'], ['save', 'gone'], ['delete', 'current'], ['delete', 'gone']] as const) test(`schedule-editor.T4 ${action} 未确认重入读取实际表单与运行记录，${result} 核对后收敛且不重放`, async () => {
  const peer = editorScenario(action === 'delete' ? 'delete-unknown' : result === 'saved' ? 'unknown-applied' : 'unknown');
  const endpoint = action === 'save' ? 'PATCH /schedules/:id' : 'DELETE /schedules/:id';
  const original = peer.gateway.overrides[endpoint]!;
  let writes = 0;
  peer.gateway.overrides[endpoint] = (context, respond) => { writes++; return original(context, respond); };
  const row = { id: 1, schedule_id: 'morning', scheduled_at: 1, started_at: null, finished_at: null, status: 'completed' as const, reason: null, conversation_id: null, name: '简报', content: '新闻', missed_before: null };
  peer.gateway.state.scheduleRuns.set('morning', [row]);
  await render(<Schedule.B5 scenario={peer} />); await tick();
  if (action === 'save') {
    await fireEvent.changeText(screen.getByTestId('schedule-name'), '不应恢复的提交稿');
    await fireEvent.press(screen.getByTestId('schedule-save'));
  } else {
    await fireEvent.press(screen.getByTestId('schedule-delete')); await tick();
    await fireEvent.press(screen.getByTestId('schedule-delete-confirm'));
  }
  await tick();
  await fireEvent.press(screen.getByTestId('schedule-back')); await tick();
  await fireEvent.press(screen.getByTestId('editor-unknown-leave')); await tick();
  // The already-started domain check remains blocked; this visit's ordinary GET can succeed.
  delete peer.gateway.overrides['GET /schedules/:id'];
  await fireEvent.press(screen.getByTestId('profile-schedule-morning')); await tick();
  const actualName = result === 'saved' ? '不应恢复的提交稿' : '每日新闻简报';
  expect(screen.getByTestId('schedule-name')).toHaveProp('value', actualName);
  expect(screen.getByTestId('schedule-name')).toHaveProp('editable', false);
  expect(screen.getByTestId('schedule-run-1')).toBeOnTheScreen();
  // The unknown state resolves automatically before the new display deadline; do not flash it.
  expect(screen.queryByRole('alert')).toBeNull();
  if (result === 'gone') peer.gateway.state.schedules = [];
  await act(() => peer.recover()); await tick(2000);
  if (result === 'gone') expect(screen.queryByTestId('schedule-name')).toBeNull();
  else {
    expect(screen.getByTestId('schedule-name')).toHaveProp('editable', true);
    expect(screen.getByTestId('schedule-name')).toHaveProp('value', actualName);
    expect(peer.session.editorOperations.get('schedule:morning')?.status).toBe(result === 'saved' ? 'confirmed' : 'synced');
  }
  expect(writes).toBe(1);
});

test('schedule-editor.C6 T3 六页追加和普通刷新不移除顶部行，新 revision 仍显示最新运行', async () => {
  const peer = editorScenario('runs-many');
  const template = peer.gateway.state.scheduleRuns.get('morning')![0];
  peer.gateway.state.scheduleRuns.set('morning', Array.from({ length: 121 }, (_, index) => ({ ...template, id: 121 - index })));
  await render(<Schedule.C6 scenario={peer} />); await tick();
  const rowIds = () => screen.getAllByTestId(/^schedule-run-\d+$/).map(row => row.props.testID as string);
  for (let page = 0; page < 5; page++) {
    await fireEvent.press(screen.getByTestId('schedule-runs-more')); await tick();
    expect(rowIds()).toEqual(Array.from({ length: (page + 2) * 20 }, (_, index) => `schedule-run-${121 - index}`));
  }
  expect(screen.getByTestId('schedule-run-2')).toBeOnTheScreen();
  await act(() => peer.updateSchedule('同一批记录刷新')); await tick();
  expect(rowIds()).toEqual(Array.from({ length: 120 }, (_, index) => `schedule-run-${121 - index}`));
  expect(screen.getByTestId('schedule-run-2')).toBeOnTheScreen();
  peer.gateway.state.scheduleRuns.get('morning')!.unshift({ ...template, id: 122 });
  await act(() => peer.updateSchedule('新增运行')); await tick();
  expect(rowIds()).toEqual(Array.from({ length: 120 }, (_, index) => `schedule-run-${122 - index}`));
});

test('schedule-editor.T5 同 key 另一消费者保持旧 GET 在途，失焦保存后迟到响应不能回退表单', async () => {
  const peer = editorScenario('runs');
  const oldRead = Promise.withResolvers<void>(), nextRead = Promise.withResolvers<void>(), write = Promise.withResolvers<void>();
  let reads = 0;
  let oldSignal: AbortSignal | null | undefined;
  await render(<Schedule.C2 scenario={peer} />); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '可靠保存值');
  // A shared consumer keeps the transport alive when the editor route unsubscribes on blur.
  const observer = new QueryObserver(gatewayQueryClient, { ...scheduleDetailOptions(peer.session, 'morning'), refetchOnMount: false });
  const stopPeer = observer.subscribe(() => {});
  peer.gateway.overrides['GET /schedules/:id'] = async ({ init }, respond) => {
    if (++reads === 1) { oldSignal = init.signal; const response = await respond(); await oldRead.promise; return response; }
    await nextRead.promise;
  };
  peer.gateway.overrides['PATCH /schedules/:id'] = async () => {
    await write.promise;
    const schedule = { ...peer.gateway.state.schedules[0], name: '可靠保存值' };
    peer.gateway.state.schedules[0] = schedule;
    return jsonResponse({ schedule, event: null });
  };
  try {
    await act(() => peer.updateSchedule('保存前的旧快照')); await tick();
    await fireEvent.press(screen.getByTestId('schedule-save')); await tick();
    await act(() => router.push('/chat?id=run-chat')); await tick();
    expect(oldSignal?.aborted).toBe(false);
    await act(() => write.resolve()); await tick();
    await act(() => oldRead.resolve()); await tick();
    expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新闻简报运行');
    await act(() => router.back()); await tick();
    expect(screen.getByTestId('schedule-name')).toHaveProp('value', '可靠保存值');
    expect(screen.getByTestId('schedule-save')).toBeEnabled();
  } finally { stopPeer(); oldRead.resolve(); nextRead.resolve(); write.resolve(); await tick(); }
});

test('G1 S1 定时自动保存后进入运行聊天，Agent 删除时连带移除保留编辑页并清空返回历史', async () => {
  const peer = editorScenario('runs');
  await render(<Schedule.C2 scenario={peer} entry="list" />); await tick();
  await act(() => router.replace('/')); await tick();
  expect(router.canGoBack()).toBe(false);
  await act(() => router.push('/schedule-editor' as never)); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '保存后运行记录删除回根');
  await fireEvent.press(screen.getByTestId('schedule-run-1')); await tick();
  expect(peer.gateway.state.schedules[0].name).toBe('保存后运行记录删除回根');
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新闻简报运行');
  await act(() => peer.removeAgent()); await tick();
  expect(screen.queryByTestId('chat-conversation-title')).toBeNull();
  expect(router.canGoBack()).toBe(false);
});
