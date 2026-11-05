import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';
import SettingsSkillsRoute from '../src/app/settings-skills';
import SkillDetailRoute from '../src/app/skill-detail';
import BuiltinSkillDetailRoute from '../src/app/builtin-skill-detail';
import AgentProfileRoute from '../src/app/agents/[id]';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
const routes = { '/skill-detail': SkillDetailRoute, '/builtin-skill-detail': BuiltinSkillDetailRoute, '/agents/[id]': AgentProfileRoute };
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer);
  peer.state.skills = [
    { name: 'research', description: '核对来源', status: 'ok', error: null, used_by: [{ id: 'research', name: '研究员' }], path: '/workspace/skills/research/SKILL.md', mtime: 1, content: '# 核对清单\n\n阅读原始资料。' },
    { name: 'broken', description: '', status: 'error', error: '缺少说明字段', used_by: [], path: '/workspace/skills/broken/SKILL.md', mtime: null, content: null },
  ];
  peer.state.builtinSkills = [{ name: 'wandrun-ui', description: '消息内交互', capability: { id: 'ui_blocks', name: '交互界面' }, used_by: [{ id: 'research', name: '研究员' }], content: '# 界面约定\n\n只读系统技能正文。' }];
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
const open = () => renderGateway(peer, SettingsSkillsRoute, '/settings-skills', routes);

test('正常与错误技能从目录到真实详情，使用者可进入资料', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('skill-broken')); await tick();
  expect(screen.getByTestId('skill-detail-error')).toHaveTextContent(/缺少说明字段/);
  expect(screen.getByText('SKILL.md 不可读取；请检查上方错误原因。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-back')); await tick();
  await fireEvent.press(screen.getByTestId('skill-research')); await tick();
  expect(screen.getByText('阅读原始资料。')).toBeOnTheScreen();
  expect(screen.getByText('/workspace/skills/research/SKILL.md')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-users-summary')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('研究员');
});

test('引用阻止删除；解除引用事件重读后可取消、删除并返回目录，外部删除同步', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('skill-research')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  expect(screen.getByText(/技能仍被 研究员 使用/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-delete-blocked'));
  await act(async () => {
    peer.state.skills[0].used_by = [];
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.getByText('没有 Agent 使用这个技能')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-cancel'));
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-confirm')); await tick();
  expect(screen.queryByTestId('skill-research')).toBeNull();
  expect(screen.getByTestId('skill-broken')).toBeOnTheScreen();
  await act(async () => {
    peer.state.skills = [];
    peer.emit(peer.event('resource.changed', { kind: 'skill', id: 'broken', op: 'deleted' }));
  }); await tick();
  expect(screen.queryByTestId('skill-broken')).toBeNull();
});

test('settings-skills.A2 B1 已移除导入快捷入口，只提示在聊天中发送技能', async () => {
  await open();
  expect(screen.queryByTestId('skills-add')).toBeNull();
  expect(screen.getByText('想导入技能，在聊天里把技能发给 Agent')).toBeOnTheScreen();
});

test('内置技能详情只读、内容可见且使用者导航至正确 Agent', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('builtin-skill-wandrun-ui')); await tick();
  expect(screen.getByText('只读系统技能正文。')).toBeOnTheScreen();
  expect(screen.queryByTestId('skill-delete')).toBeNull();
  await fireEvent.press(screen.getByTestId('builtin-agent-research')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('研究员');
});

test('技能删除预检查不复用旧约束，也不因 Query 联网判断暂停而卡住', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('skill-research')); await tick();
  try {
    onlineManager.setOnline(false);
    peer.state.skills[0].used_by = [];
    await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
    expect(screen.getByTestId('skill-delete-confirm')).toBeOnTheScreen();
  } finally { onlineManager.setOnline(true); await tick(); }
});
