import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as stories from '../src/dev/agent-profile.stories';
import { agentProfileScenario } from '../src/dev/agent-profile-scenario';
import { gatewayQueryClient } from '../src/lib/gateway-queries';
import { GatewayApi } from '../src/gateway/api';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const Stories = composeStories(stories);
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const tick = async (ms = 200) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

test('agent-profile.A1 首次详情 404 退出资料，不保留名字和编辑入口', async () => {
  const peer = agentProfileScenario('A1');
  await render(<Stories.A6 scenario={peer} />); await tick();
  expect(screen.getByTestId('agents-add')).toBeOnTheScreen();
  expect(screen.queryByTestId('profile-name')).toBeNull();
  expect(screen.queryByTestId('profile-edit')).toBeNull();
});

test('agent-profile.A4 T1 刷新失败保留旧资料，刷新 404 撤销资料与编辑入口', async () => {
  const peer = agentProfileScenario('A6');
  await render(<Stories.A6 scenario={peer} />); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('小万');
  await act(async () => peer.failDetailRead('unavailable')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('小万');
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent('无法加载资料，正在重试…');
  await act(async () => peer.failDetailRead('not-found')); await tick();
  expect(screen.queryByTestId('profile-name')).toBeNull();
  expect(screen.queryByTestId('profile-edit')).toBeNull();
  expect(screen.getByTestId('agents-add')).toBeOnTheScreen();
});

test('agent-profile.A3 A6 B2 默认浏览器，切标签保持四入口且没有新增动作', async () => {
  await render(<Stories.A6 />); await tick();
  expect(screen.getByRole('tab', { name: '浏览器', selected: true })).toBeOnTheScreen();
  expect(screen.getByText('没有浏览器页面')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('profile-tab-schedules')); await tick();
  expect(screen.getByText('还没有定时')).toBeOnTheScreen();
  expect(screen.queryByTestId('profile-schedule-add')).toBeNull();
});

test('agent-profile.A2 T1 在途详情禁编辑，返回成功后启用', async () => {
  const peer = agentProfileScenario('A2');
  await render(<Stories.A2 scenario={peer} />); await tick();
  expect(screen.getByTestId('profile-edit')).toBeDisabled();
  await act(() => peer.release()); await tick();
  expect(screen.getByTestId('profile-edit')).toBeEnabled();
});

test('agent-profile.A4 T1 详情失败自动恢复，不放手动重试', async () => {
  const peer = agentProfileScenario('A4');
  await render(<Stories.A4 scenario={peer} />); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  expect(screen.queryByText('重试')).toBeNull();
  peer.recover(); await tick(1500);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('profile-edit')).toBeEnabled();
});

test('agent-profile.A5 连接失败保留资料并立即禁写入口', async () => {
  await render(<Stories.A5 />); await tick(1500);
  expect(screen.getByTestId('profile-name')).toHaveTextContent('小万');
  expect(screen.getByTestId('profile-edit')).toBeDisabled();
  expect(screen.getByTestId('profile-computer-card-login')).toBeOnTheScreen();
  for (const action of screen.getAllByLabelText('关闭此任务的全部浏览器页面')) expect(action).toBeDisabled();
  expect(screen.queryByText('无法加载资料，正在重试…')).toBeNull();
});

test('agent-profile.B1 B5 首读与失败都不冒充确定空态', async () => {
  const first = await render(<Stories.B1 />); await tick();
  expect(screen.getByText('正在加载浏览器页面…')).toBeOnTheScreen();
  expect(screen.queryByText('没有浏览器页面')).toBeNull();
  await first.unmount();
  await render(<Stories.B5 />); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载浏览器页面，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('没有浏览器页面')).toBeNull();
});

test('agent-profile.C1 C3 C4 读取中/失败与确定空列表分开', async () => {
  const view = await render(<Stories.C1 />); await tick();
  expect(screen.getByText('正在加载定时…')).toBeOnTheScreen();
  expect(screen.queryByText('还没有定时')).toBeNull();
  await view.unmount(); await render(<Stories.C4 />); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载定时，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('还没有定时')).toBeNull();
});

test('agent-profile.C2 C5 T3 T4 更新在途禁所有开关，响应后采用服务端结果', async () => {
  const peer = agentProfileScenario('C5');
  await render(<Stories.C5 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-weekly'));
  expect(screen.getByTestId('profile-schedule-enabled-morning')).toBeDisabled();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).not.toBeChecked();
  await act(() => peer.release()); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).toBeChecked();
  expect(screen.getByTestId('profile-schedule-enabled-morning')).toBeEnabled();
});

test('agent-profile.C5 C6 更新失败保留原启用状态，已结束项不能启用', async () => {
  const view = await render(<Stories.C5Failure />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-weekly')); await tick();
  expect(screen.getByTestId('profile-schedules-update-error')).toBeOnTheScreen();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).not.toBeChecked();
  await view.unmount(); await render(<Stories.C6 />); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-morning')).toBeDisabled();
  expect(screen.getByTestId('profile-schedule-morning')).toHaveTextContent(/已结束/);
});

test('agent-profile.C7 已有定时修改后返回更新列表，再经确认删除', async () => {
  await render(<Stories.C7 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-weekly')); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-name'), '复盘已修改');
  await fireEvent.press(screen.getByTestId('schedule-save')); await tick();
  expect(screen.getByText('复盘已修改')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('profile-schedule-weekly')); await tick();
  await fireEvent.press(screen.getByTestId('schedule-delete')); await tick();
  expect(screen.getByText('之后不再触发；已创建的对话仍会保留。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('schedule-delete-confirm')); await tick();
  expect(screen.queryByTestId('profile-schedule-weekly')).toBeNull();
  expect(screen.getByTestId('profile-schedule-morning')).toBeOnTheScreen();
});

test('agent-profile.D1 D3 D4 成员加载、为空与缺资料互不混淆，不再有修改按钮', async () => {
  const view = await render(<Stories.D1 />); await tick();
  expect(screen.getByText('正在加载成员…')).toBeOnTheScreen();
  expect(screen.queryByText('没有成员')).toBeNull();
  await view.unmount(); const empty = await render(<Stories.D3 />); await tick();
  expect(screen.getByText('没有成员')).toBeOnTheScreen();
  expect(screen.queryByTestId('profile-edit-members')).toBeNull();
  await empty.unmount(); await render(<Stories.D4 />); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载成员，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('没有成员')).toBeNull();
});

test('agent-profile.D2 D5 成员有真实对话时恢复；无对话只打开本地页，不创建资源', async () => {
  const view = await render(<Stories.D2 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-member-researcher')); await tick(200);
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('研究员');
  expect(screen.queryByTestId('new-chat-agent-researcher')).toBeNull();
  await view.unmount();
  const peer = agentProfileScenario('D5');
  const create = jest.spyOn(GatewayApi.prototype, 'createConversation');
  await render(<Stories.D5 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-member-researcher')); await tick();
  expect(screen.getByTestId('new-chat-agent-researcher')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input')).toBeEnabled();
  expect(create).not.toHaveBeenCalled();
});


test('agent-profile.E1 E3 E5 空或尚未读取时两行都可达正确的独立阅读资源', async () => {
  const view = await render(<Stories.E1 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-work-memory')); await tick();
  expect(screen.queryByTestId('profile-memory-content')).toBeNull();
  expect(screen.queryByTestId('profile-memory-edit')).toBeNull();
  await view.unmount(); await render(<Stories.E3 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-about-you')); await tick();
  expect(screen.getByTestId('profile-shared-memory-empty')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('profile-shared-memory-edit')); await tick();
  expect(screen.getByLabelText('关于你 Markdown')).toBeOnTheScreen();
});

test('agent-profile.E4 T5 失败入口仍可点，阅读面自动恢复且没有手动重试', async () => {
  const peer = agentProfileScenario('E4');
  await render(<Stories.E4 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-work-memory')); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载记忆，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('重试')).toBeNull();
  peer.recover(); await tick(1500);
  expect(screen.getByTestId('profile-memory-content')).toBeOnTheScreen();
  expect(screen.queryByText('无法加载记忆，正在重试…')).toBeNull();
});

test('agent-profile.F2 F3 F6 核对未存保留输入，超限禁保存，未保存返回需确认', async () => {
  await render(<Stories.F3 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '本地草稿');
  await fireEvent.press(screen.getByTestId('memory-editor-save')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('本地草稿');
  expect(screen.getByTestId('memory-editor-save')).toBeEnabled();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '字'.repeat(1001));
  expect(screen.getByTestId('memory-editor-save')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('memory-editor-back'));
  expect(screen.getByTestId('memory-discard-dialog')).toBeOnTheScreen();
});

test('agent-profile.F4 F5 T6 冲突对比最新版本，显式重载只换基线并保留草稿', async () => {
  await render(<Stories.F4 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '核对后的草稿');
  await fireEvent.press(screen.getByTestId('memory-editor-save')); await tick();
  expect(screen.getByTestId('memory-editor-conflict')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-editor-save')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('memory-editor-view-current'));
  expect(screen.getByTestId('memory-editor-current')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('memory-editor-reload')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('核对后的草稿');
  expect(screen.getByTestId('memory-editor-save')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('memory-editor-save')); await tick();
  expect(screen.getByText('核对后的草稿')).toBeOnTheScreen();
});

test('agent-profile.F7 G2 G3 受管详情与未引用详情保留，详情编辑不改索引正文', async () => {
  await render(<Stories.E2Reader />); await tick();
  await fireEvent.press(screen.getByTestId('memory-index-detail-project')); await tick();
  expect(screen.getByTestId('memory-detail-content')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('memory-detail-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '修改详情正文');
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  expect(screen.getByText('工作方式')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  expect(screen.getByTestId('memory-editor-detail-notes')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-editor-new-detail')).toBeOnTheScreen();
});

test('agent-profile.B3 B4 B7 T2 关闭失败保留任务，重试后移除整租约', async () => {
  const peer = agentProfileScenario('B7');
  await render(<Stories.B7 scenario={peer} />); await tick();
  await fireEvent.press(screen.getAllByLabelText('关闭此任务的全部浏览器页面')[0]); await tick();
  expect(screen.getByTestId('profile-computer-close-error')).toBeOnTheScreen();
  peer.recover();
  await fireEvent.press(screen.getAllByLabelText('关闭此任务的全部浏览器页面')[0]); await tick();
  expect(screen.queryByTestId('profile-computer-card-login')).toBeNull();
  expect(screen.getByTestId('profile-computer-card-research')).toBeOnTheScreen();
});

test('agent-profile.E4 T5 已有快照刷新失败保留摘要与修改者', async () => {
  const peer = agentProfileScenario('E4Stale');
  await render(<Stories.E4Stale scenario={peer} />); await tick();
  expect(screen.getByTestId('profile-work-memory')).toBeOnTheScreen();
  expect(screen.getByText(/· 小万 修改$/)).toBeOnTheScreen();
  await act(() => peer.changeMemory('远端更新'));
  await waitFor(() => expect(screen.getByText('无法加载记忆，正在重试…')).toBeOnTheScreen(), { timeout: 4000 });
  expect(screen.queryByText('暂不可用')).toBeNull();
  expect(screen.getByTestId('profile-work-memory')).toBeOnTheScreen();
  expect(screen.getByText(/· 小万 修改$/)).toBeOnTheScreen();
});

test('agent-profile.G1 G4 详情加载无编辑，核对未存后可继续编辑完整正文', async () => {
  const view = await render(<Stories.G1 />); await tick();
  expect(screen.queryByTestId('memory-detail-content')).toBeNull();
  expect(screen.queryByTestId('memory-detail-edit')).toBeNull();
  await view.unmount(); await render(<Stories.G4 />); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '详情未保存草稿');
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue('详情未保存草稿');
  expect(screen.getByTestId('memory-detail-save')).toBeEnabled();
});

test('agent-profile.G5 T7 详情冲突保留编辑文字，重载只更新保存基线', async () => {
  await render(<Stories.G5 />); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '需要保留的详情草稿');
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  expect(screen.getByTestId('memory-detail-conflict')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-detail-save')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('memory-detail-reload')); await tick();
  expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue('需要保留的详情草稿');
  expect(screen.getByTestId('memory-detail-save')).toBeEnabled();
});

test('agent-profile.G6 G8 G11 删除回执未知但核对仍为原版本，保留核对索引且离开需确认', async () => {
  await render(<Stories.G7 />); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-delete')); await tick();
  const reviewed = screen.getByTestId('memory-detail-delete-index').props.value;
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  expect(screen.getByTestId('memory-detail-delete-dialog')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(screen.getByTestId('memory-detail-save-result')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveDisplayValue(reviewed);
  await fireEvent.press(screen.getByTestId('memory-detail-back'));
  expect(screen.getByTestId('memory-discard-dialog')).toBeOnTheScreen();
});

test.each([
  { surface: '资料页', Story: Stories.B6, closed: 'profile-computer-card-login' },
  { surface: '设置电脑', Story: Stories.B6Settings, closed: 'settings-computer-page-login-signin' },
])('agent-profile.B6 $surface 关闭在途禁用重复操作，完成后刷新任务集合', async ({ Story, closed }) => {
  const peer = agentProfileScenario('B6');
  await render(<Story scenario={peer} />); await tick();
  await fireEvent.press(screen.getAllByLabelText('关闭此任务的全部浏览器页面')[0]); await tick();
  for (const action of screen.getAllByLabelText('关闭此任务的全部浏览器页面')) expect(action).toBeDisabled();
  expect(screen.getByTestId(closed)).toBeOnTheScreen();
  await act(() => peer.release()); await tick();
  expect(screen.queryByTestId(closed)).toBeNull();
});

test('agent-profile.C7 既有表单的每周、Cron 与启用修改可往返读取', async () => {
  await render(<Stories.C7 />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-morning')); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-content'), '修改后的提醒内容');
  await fireEvent.press(screen.getByTestId('schedule-kind-weekly')); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-time'), '09:30');
  for (let day = 1; day <= 7; day++) {
    const item = screen.getByTestId(`schedule-weekday-${day}`);
    if (!!item.props.accessibilityState?.checked !== (day === 5)) await fireEvent.press(item);
  }
  await fireEvent.press(screen.getByTestId('schedule-save')); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-morning')); await tick();
  expect(screen.getByTestId('schedule-content')).toHaveDisplayValue('修改后的提醒内容');
  expect(screen.getByTestId('schedule-time')).toHaveDisplayValue('09:30');
  expect(screen.getByTestId('schedule-weekday-5')).toHaveProp('accessibilityState', expect.objectContaining({ checked: true }));
  expect(screen.getByTestId('schedule-weekday-1')).toHaveProp('accessibilityState', expect.objectContaining({ checked: false }));
  await fireEvent.press(screen.getByTestId('schedule-kind-cron')); await tick();
  await fireEvent.changeText(screen.getByTestId('schedule-cron'), '0 8 * * 1,5');
  await fireEvent(screen.getByTestId('schedule-enabled'), 'checkedChange', false);
  await fireEvent.press(screen.getByTestId('schedule-save')); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-morning')).not.toBeChecked();
  await fireEvent.press(screen.getByTestId('profile-schedule-morning')); await tick();
  expect(screen.getByTestId('schedule-cron')).toHaveDisplayValue('0 8 * * 1,5');
});

test('agent-profile.F7 G3 G4 T8 新建详情校验标识，保存中冻结所有输入且不丢索引草稿', async () => {
  const peer = agentProfileScenario('F3Pending');
  await render(<Stories.E2Reader scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  const index = screen.getByTestId('memory-editor-input').props.value;
  await fireEvent.press(screen.getByTestId('memory-editor-new-detail')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-detail-slug'), '不合法/标识');
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '新详情正文');
  expect(screen.getByTestId('memory-detail-save')).toBeDisabled();
  await fireEvent.changeText(screen.getByTestId('memory-detail-slug'), 'tablet-notes');
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  expect(screen.getByTestId('memory-detail-slug')).toHaveProp('editable', false);
  expect(screen.getByTestId('memory-detail-input')).toHaveProp('editable', false);
  await fireEvent.press(screen.getByTestId('memory-detail-back')); await tick();
  expect(screen.getByTestId('memory-detail-input')).toBeOnTheScreen();
  await act(() => peer.release()); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue(index);
  expect(screen.getByTestId('memory-editor-conflict')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('memory-editor-reload')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue(index);
  await fireEvent.press(screen.getByTestId('memory-editor-detail-tablet-notes')); await tick();
  expect(screen.getByTestId('memory-detail-content')).toHaveTextContent('新详情正文');
});

test('agent-profile.T3 新版定时列表先到，旧读取迟到不覆盖最新行', async () => {
  const peer = agentProfileScenario('C1Stale');
  await render(<Stories.C2 scenario={peer} />); await tick();
  expect(screen.getByText('正在加载定时…')).toBeOnTheScreen();
  await act(() => peer.changeSchedules('远端最新定时')); await tick();
  expect(screen.getByTestId('profile-schedule-morning')).toHaveTextContent(/远端最新定时/);
  await act(() => peer.release()); await tick();
  expect(screen.getByTestId('profile-schedule-morning')).toHaveTextContent(/远端最新定时/);
  expect(screen.queryByText('每日英语微课程')).toBeNull();
});

test('agent-profile.T4 迟到开关响应不覆盖更新版本，后续重读前仍显示新快照', async () => {
  const peer = agentProfileScenario('C5Stale');
  await render(<Stories.C2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-weekly'));
  await act(() => peer.changeSchedules('已在别处更新')); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).not.toBeChecked();
  await act(() => peer.release()); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).not.toBeChecked();
  expect(screen.getByTestId('profile-schedule-morning')).toHaveTextContent(/已在别处更新/);
  await act(() => peer.recover()); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).not.toBeChecked();
});

test('agent-profile.F1 G1 读失败自动重试，初读期间没有可编辑的旧正文', async () => {
  const pending = agentProfileScenario('F1');
  const loading = await render(<Stories.F1 scenario={pending} />); await tick();
  expect(screen.getByTestId('memory-editor-save')).toBeDisabled();
  expect(screen.queryByTestId('memory-editor-input')).toBeNull();
  await act(() => pending.release()); await tick();
  expect(screen.getByTestId('memory-editor-input')).toBeOnTheScreen();
  await loading.unmount();
  const editor = agentProfileScenario('F1Failure');
  const failed = await render(<Stories.F1Failure scenario={editor} />); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载记忆，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('重新加载…')).toBeNull();
  editor.recover(); await tick(1100);
  expect(screen.getByTestId('memory-editor-input')).toBeOnTheScreen();
  await failed.unmount();
  const detail = agentProfileScenario('G1Failure');
  await render(<Stories.G1Failure scenario={detail} />); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载记忆详情，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByTestId('memory-detail-edit')).toBeNull();
  detail.recover(); await tick(1100);
  expect(screen.getByTestId('memory-detail-content')).toBeOnTheScreen();
});

test('agent-profile.F5 重载失败保留草稿与冲突，恢复后只换保存基线', async () => {
  const peer = agentProfileScenario('F5');
  await render(<Stories.F5 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '重载失败也不能丢的草稿');
  await fireEvent.press(screen.getByTestId('memory-editor-save')); await tick();
  await fireEvent.press(screen.getByTestId('memory-editor-reload')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('重载失败也不能丢的草稿');
  expect(screen.getByTestId('memory-editor-conflict')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-editor-reload-error')).toHaveTextContent(/草稿仍在/);
  expect(screen.getByTestId('memory-editor-save')).toBeDisabled();
  peer.recover();
  await fireEvent.press(screen.getByTestId('memory-editor-reload')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('重载失败也不能丢的草稿');
  expect(screen.getByTestId('memory-editor-save')).toBeEnabled();
});

test.each([
  { surface: '资料页', Story: Stories.B3, prefix: 'profile-computer' },
  { surface: '设置电脑', Story: Stories.B3Settings, prefix: 'settings-computer' },
])('agent-profile.B4 B6 B7 $surface 点 X 直接关闭同任务两页，不影响其他任务', async ({ Story, prefix }) => {
  await render(<Story />); await tick();
  if (prefix === 'profile-computer') await fireEvent.press(screen.getByTestId('profile-computer-other-pages'));
  expect(screen.getByTestId(`${prefix}-page-research-docs`)).toBeOnTheScreen();
  expect(screen.getByTestId(`${prefix}-page-research-github`)).toBeOnTheScreen();
  await fireEvent.press(screen.getAllByLabelText('关闭此任务的全部浏览器页面')[prefix === 'profile-computer' ? 3 : 2]); await tick();
  expect(screen.queryByTestId(`${prefix}-page-research-docs`)).toBeNull();
  expect(screen.queryByTestId(`${prefix}-page-research-github`)).toBeNull();
  expect(screen.getByTestId(`${prefix}-page-review-reference`)).toBeOnTheScreen();
});

test('agent-profile.B7 设置电脑关闭失败就地显示，重新左滑点 X 可恢复', async () => {
  const peer = agentProfileScenario('B7');
  await render(<Stories.B7Settings scenario={peer} />); await tick();
  await fireEvent.press(screen.getAllByLabelText('关闭此任务的全部浏览器页面')[0]); await tick();
  expect(screen.getByTestId('settings-computer-close-error')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-computer-page-login-signin')).toBeOnTheScreen();
  peer.recover();
  await fireEvent.press(screen.getAllByLabelText('关闭此任务的全部浏览器页面')[0]); await tick();
  expect(screen.queryByTestId('settings-computer-page-login-signin')).toBeNull();
  expect(screen.getByTestId('settings-computer-page-research-docs')).toBeOnTheScreen();
});

test('agent-profile.C8 T24 结果未知期间禁开关不重放，恢复后显示实际状态并解禁', async () => {
  const peer = agentProfileScenario('C8');
  await render(<Stories.C8 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-weekly')); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent(/保存结果未确认/);
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).toBeDisabled();
  expect(screen.getByTestId('profile-schedule-enabled-morning')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-weekly')); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent(/保存结果未确认/);
  await act(() => peer.recover()); await tick(1500);
  expect(screen.queryByText(/保存结果未确认/)).toBeNull();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).toBeChecked();
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).toBeEnabled();
});

test('agent-profile.C5 session 关闭后迟到开关结果不得重建旧 Query 缓存', async () => {
  const peer = agentProfileScenario('C5');
  const mounted = await render(<Stories.C5 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-weekly'));
  expect(screen.getByTestId('profile-schedule-enabled-weekly')).toBeDisabled();
  await mounted.unmount();
  await tick();
  expect(gatewayQueryClient.getQueryCache().findAll({ queryKey: [peer.session.queryIdentity] })).toEqual([]);
});
