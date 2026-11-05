import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Pressable, Text } from 'react-native';
import * as skills from '../src/dev/settings-skills.stories';
import * as appearance from '../src/dev/settings-appearance.stories';
import { skillsScenario } from '../src/dev/skills-scenario';
import { skillDeletion } from '../src/lib/skill-deletion';
import { SkillsList } from '../src/app/settings-skills';
import { SceneProviders } from '../src/dev/scene-providers';
import { jsonResponse } from '../src/dev/fake-gateway';
import { router } from 'expo-router';
import AppearanceSettings from '../src/app/settings-appearance';
import { AppearanceStore } from '../src/lib/appearance';
import { AppearanceProvider, AppearanceStoreProvider } from '../src/lib/appearance-context';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const Skills = composeStories(skills);
const Appearance = composeStories(appearance);
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const tick = (ms = 0) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

test('settings-skills.A4 两个目录失败只有一个横幅，不呈现确定空态或手动重试', async () => {
  await render(<Skills.A4 />); await tick();
  await tick(3000);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByText('无法加载技能，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('暂无技能')).toBeNull();
  expect(screen.queryByText('重试')).toBeNull();
});

test('settings-skills.D4 明确失败留在组件库确认框，可以取消', async () => {
  await render(<Skills.D4Failed />); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-confirm')); await tick();
  expect(screen.getByTestId('skill-delete-error')).toHaveTextContent('技能目录只读，无法删除');
  expect(screen.getByTestId('skill-delete-confirm')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('skill-delete-cancel')); await tick();
  expect(screen.queryByTestId('skill-delete-confirm')).toBeNull();
});

test('settings-skills.D4 未确认禁止再次删除但返回仍可操作', async () => {
  await render(<Skills.D4Unknown />); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-confirm')); await tick();
  await tick(3000);
  expect(screen.getByText('删除结果未确认；可以离开，恢复连接后会自动核对。')).toBeOnTheScreen();
  expect(screen.getByTestId('skill-delete')).toBeDisabled();
  expect(screen.getByTestId('skill-back')).toBeEnabled();
  expect(screen.queryByTestId('skill-delete-confirm')).toBeNull();
});

test('settings-appearance.A4 写入失败仍保持原选择，提示位于页面顶部且可再选', async () => {
  await render(<Appearance.A4 />); await tick();
  await fireEvent.press(screen.getByTestId('appearance-language-en')); await tick();
  expect(screen.getByTestId('appearance-save-error')).toHaveTextContent('无法保存外观设置，请重试。');
  expect(screen.getByTestId('appearance-language-zh')).toBeChecked();
  expect(screen.getByTestId('appearance-language-en')).not.toBeChecked();
  expect(screen.getByTestId('appearance-language-en')).toBeEnabled();
});

test('settings-appearance.A4 S2 写入失败属于本次访问：离开外观页再进入不再带着旧错误', async () => {
  const store = new AppearanceStore({ read: async () => null, write: async () => { throw new Error('disk'); } }, () => {});
  await render(<AppearanceStoreProvider store={store}><AppearanceProvider>
    <SceneProviders path="/" routes={{ '/settings-appearance': AppearanceSettings }}>
      <Pressable testID="open-appearance" onPress={() => router.push('/settings-appearance')}><Text>设置</Text></Pressable>
    </SceneProviders>
  </AppearanceProvider></AppearanceStoreProvider>); await tick();
  await fireEvent.press(screen.getByTestId('open-appearance')); await tick();
  await fireEvent.press(screen.getByTestId('appearance-language-en')); await tick();
  expect(screen.getByTestId('appearance-save-error')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('appearance-back')); await tick();
  expect(store.snapshot().error).toBeNull();
  await fireEvent.press(screen.getByTestId('open-appearance')); await tick();
  expect(screen.queryByTestId('appearance-save-error')).toBeNull();
});

test('settings-appearance.A4 N1 写入在途时离开外观页，之后失败：再次进入不显示旧访问的失败', async () => {
  const write = Promise.withResolvers<void>();
  const store = new AppearanceStore({ read: async () => null, write: () => write.promise }, () => {});
  await render(<AppearanceStoreProvider store={store}><AppearanceProvider>
    <SceneProviders path="/" routes={{ '/settings-appearance': AppearanceSettings }}>
      <Pressable testID="open-appearance" onPress={() => router.push('/settings-appearance')}><Text>设置</Text></Pressable>
    </SceneProviders>
  </AppearanceProvider></AppearanceStoreProvider>); await tick();
  await fireEvent.press(screen.getByTestId('open-appearance')); await tick();
  await fireEvent.press(screen.getByTestId('appearance-language-en')); await tick();
  await fireEvent.press(screen.getByTestId('appearance-back')); await tick();
  await act(async () => { write.reject(new Error('disk')); }); await tick();
  expect(store.snapshot().saving).toBe(false);
  await fireEvent.press(screen.getByTestId('open-appearance')); await tick();
  expect(screen.queryByTestId('appearance-save-error')).toBeNull();
  expect(screen.getByTestId('appearance-language-zh')).toBeChecked();
});

test('settings-appearance.A4 S2 写入失败横幅内 × 关闭，原选择保持', async () => {
  await render(<Appearance.A4 />); await tick();
  await fireEvent.press(screen.getByTestId('appearance-language-en')); await tick();
  expect(screen.getByTestId('appearance-save-error')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('appearance-save-error-dismiss')); await tick();
  expect(screen.queryByTestId('appearance-save-error')).toBeNull();
  expect(screen.getByTestId('appearance-language-zh')).toBeChecked();
});

test('settings-skills.A2 C4 D2 使用中的技能从目录进入详情，删除只给出解除引用提示', async () => {
  await render(<Skills.A2 />); await tick();
  expect(screen.getByTestId('skill-status-notes')).toHaveTextContent('2 个 Agent 使用');
  await fireEvent.press(screen.getByTestId('skill-notes')); await tick();
  expect(screen.getByTestId('skill-users-summary')).toHaveTextContent('研究员、写作助手');
  await fireEvent.press(screen.getByTestId('skill-users-summary')); await tick();
  expect(screen.getByTestId('skill-agent-research')).toBeOnTheScreen();
  expect(screen.getByTestId('skill-agent-writer')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-users-backdrop')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  expect(screen.getByText(/技能仍被 研究员、写作助手 使用/)).toBeOnTheScreen();
  expect(screen.queryByTestId('skill-delete-confirm')).toBeNull();
  await fireEvent.press(screen.getByTestId('skill-delete-blocked')); await tick();
  expect(screen.getByTestId('skill-delete')).toBeEnabled();
});

test('settings-skills.C4 多人汇总通过弹层选择第五个 Agent 并进入正确资料', async () => {
  await render(<Skills.C4Many />); await tick();
  expect(screen.getByTestId('skill-status-notes')).toHaveTextContent('5 个 Agent 使用');
  await fireEvent.press(screen.getByTestId('skill-notes')); await tick();
  expect(screen.getByTestId('skill-users-summary')).toHaveTextContent('研究员、写作助手等 5 个');
  await fireEvent.press(screen.getByTestId('skill-users-summary')); await tick();
  for (const name of ['研究员', '写作助手', '规划助手', '审阅助手', '资料助手']) expect(screen.getByText(name)).toBeOnTheScreen();
  for (const id of ['research', 'writer', 'planner', 'reviewer', 'archive']) expect(screen.getByTestId(`skill-agent-${id}`)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-agent-archive')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('资料助手');
  expect(screen.queryByTestId('skill-users-sheet')).toBeNull();
});

test('settings-skills.C1 首次详情失败只显示读取反馈，不把缺数据当成技能空内容', async () => {
  await render(<Skills.C1 />); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent('无法加载技能，正在重试…');
  expect(screen.queryByTestId('skill-content')).toBeNull();
  expect(screen.queryByTestId('skill-delete')).toBeNull();
  expect(screen.getByTestId('skill-back')).toBeEnabled();
});

test('settings-skills.C4 使用者弹层点遮罩与系统返回都关闭，不离开详情', async () => {
  const nativeBack = jest.spyOn(BackHandler, 'addEventListener');
  await render(<Skills.D2 />); await tick();
  await fireEvent.press(screen.getByTestId('skill-users-summary')); await tick();
  await fireEvent.press(screen.getByTestId('skill-users-backdrop')); await tick();
  expect(screen.queryByTestId('skill-users-sheet')).toBeNull();
  expect(screen.getByTestId('skill-users-summary')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-users-summary')); await tick();
  const handler = nativeBack.mock.calls.filter(([event]) => event === 'hardwareBackPress').at(-1)?.[1];
  expect(handler).toBeDefined();
  await act(() => { expect(handler?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true); }); await tick();
  expect(screen.queryByTestId('skill-users-sheet')).toBeNull();
  expect(screen.getByTestId('skill-users-summary')).toBeOnTheScreen();
});

test('settings-skills.A1 A3 目录独立成功，确定空态不隐藏内置技能', async () => {
  const view = await render(<Skills.A1 />); await tick(300);
  expect(screen.getByTestId('builtin-skill-wandrun-ui')).toBeOnTheScreen();
  expect(screen.queryByText('暂无技能')).toBeNull();
  await view.unmount();
  await render(<Skills.A3 />); await tick();
  expect(screen.getByText('暂无技能')).toBeOnTheScreen();
  expect(screen.getByTestId('builtin-skill-wandrun-ui')).toBeOnTheScreen();
});

test('settings-skills.A5 C3 坏技能保留原因、元数据与删除入口', async () => {
  await render(<Skills.A5 />); await tick();
  expect(screen.getByTestId('skill-error-source-check')).toHaveTextContent(/缺少 SKILL.md/);
  await fireEvent.press(screen.getByTestId('skill-source-check')); await tick();
  expect(screen.getByTestId('skill-detail-error')).toHaveTextContent(/缺少 SKILL.md/);
  expect(screen.getByText('不可用')).toBeOnTheScreen();
  expect(screen.getByTestId('skill-content')).toHaveTextContent(/SKILL.md 不可读取/);
  expect(screen.getByTestId('skill-delete')).toBeEnabled();
});

test('settings-skills.C4 单人汇总不打开选择层，直接进入该 Agent', async () => {
  await render(<Skills.C4Single />); await tick();
  await fireEvent.press(screen.getByTestId('skill-notes')); await tick();
  await fireEvent.press(screen.getByTestId('skill-users-summary')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('研究员');
  expect(screen.queryByTestId('skill-users-sheet')).toBeNull();
});

test('settings-skills.D3 删除取消不移除技能，确认成功回列表并同步目录', async () => {
  await render(<Skills.A2 />); await tick();
  await fireEvent.press(screen.getByTestId('skill-source-check')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-cancel')); await tick();
  expect(screen.getByTestId('skill-content')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-confirm')); await tick();
  expect(screen.queryByTestId('skill-source-check')).toBeNull();
  expect(screen.getByTestId('skill-notes')).toBeOnTheScreen();
});

test('settings-skills.D4 T1 最终 409 以最新使用关系阻止删除', async () => {
  await render(<Skills.D4Conflict />); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete')); await tick();
  await fireEvent.press(screen.getByTestId('skill-delete-confirm')); await tick();
  expect(screen.getByText(/技能仍被 研究员、写作助手 使用/)).toBeOnTheScreen();
  expect(screen.queryByTestId('skill-delete-confirm')).toBeNull();
});

test.each(['C5', 'E3'] as const)('settings-skills.%s 详情不存在时回技能目录而非读取错误', async (story) => {
  await render(story === 'C5' ? <Skills.C5 /> : <Skills.E3 />); await tick();
  expect(screen.getByTestId('skills-back')).toBeOnTheScreen();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('settings-skills.E1 E2 内置详情失败不显示假正文，恢复场景只读', async () => {
  const view = await render(<Skills.E1 />); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent('无法加载内置技能，正在重试…');
  expect(screen.queryByTestId('skill-delete')).toBeNull();
  await view.unmount();
  await render(<Skills.E2 />); await tick();
  expect(screen.getByTestId('builtin-capability')).toHaveTextContent('交互界面');
  expect(screen.queryByTestId('skill-delete')).toBeNull();
});

test('settings-appearance.A2 A3 A5 A6 保存期间保留旧值并禁重复，成功才应用主题', async () => {
  await render(<Appearance.A2 />); await tick();
  await fireEvent.press(screen.getByTestId('appearance-theme-dark')); await tick();
  expect(screen.getByTestId('appearance-theme-system')).toBeChecked();
  expect(screen.getByTestId('appearance-theme-dark')).not.toBeChecked();
  expect(screen.getByTestId('appearance-language-en')).toBeDisabled();
  expect(screen.getByTestId('appearance-back')).toBeEnabled();
  await tick(1500);
  expect(screen.getByTestId('appearance-theme-dark')).toBeChecked();
  expect(screen.getByTestId('appearance-language-en')).toBeEnabled();
});

test('settings-appearance.B1 恢复完成前不挂载页面', async () => {
  await render(<Appearance.B1 />); await tick(300);
  expect(screen.queryByTestId('appearance-language-zh')).toBeNull();
  expect(screen.queryByTestId('appearance-back')).toBeNull();
});

test('settings-appearance.B2 暂时读取失败自动重读并挂载原偏好，无手动按钮', async () => {
  await render(<Appearance.B2Retry />); await tick();
  expect(screen.getByRole('alert')).toHaveTextContent('无法读取外观设置，正在重试…');
  expect(screen.queryByTestId('appearance-language-zh')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  await tick(1000);
  expect(screen.getByTestId('appearance-language-zh')).toBeChecked();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('settings-appearance.B2 损坏内容停在根错误，不挂载页面或自动清空', async () => {
  await render(<Appearance.B2Invalid />); await tick(30000);
  expect(screen.getByRole('alert')).toHaveTextContent('已保存的外观设置无法读取，未更改原有设置。');
  expect(screen.queryByTestId('appearance-language-zh')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test.each([false, true])('settings-skills.D4 T2 未确认离开后只读核对，当前已删除=%s', async (deleted) => {
  const peer = skillsScenario('D4-unknown');
  let deletes = 0;
  peer.gateway.overrides['DELETE /skills/:name'] = () => {
    deletes++;
    return jsonResponse({ error: { code: 'unavailable', message: '回执未取得' } }, 503);
  };
  peer.gateway.overrides['GET /skills/:name'] = () => {
    if (deletes) return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
  };
  try {
    peer.start(); await tick();
    const operation = skillDeletion(peer.session, 'source-check');
    await operation.preflight();
    await operation.remove(); await tick();
    expect(operation.snapshot().phase).toBe('unknown');
    operation.leave();
    await operation.preflight(); await operation.remove();
    expect(deletes).toBe(1);
    delete peer.gateway.overrides['GET /skills/:name'];
    if (deleted) peer.gateway.state.skills = peer.gateway.state.skills.filter(skill => skill.name !== 'source-check');
    await tick(1000);
    expect(operation.snapshot().phase).toBe(deleted ? 'deleted' : 'idle');
    expect(deletes).toBe(1);
  } finally { peer.stop(); await tick(); }
});

test('settings-skills.D1 T2 离开后预检查迟到不重新打开确认层', async () => {
  const peer = skillsScenario('A2');
  const response = Promise.withResolvers<Response>();
  try {
    peer.start(); await tick();
    peer.gateway.overrides['GET /skills/:name'] = () => response.promise;
    const operation = skillDeletion(peer.session, 'source-check');
    const pending = operation.preflight();
    operation.leave();
    response.resolve(jsonResponse(peer.gateway.state.skills[0]));
    await pending;
    expect(operation.snapshot().phase).toBe('idle');
  } finally { peer.stop(); await tick(); }
});

test('settings-skills.A6 离线保留目录与详情阅读，禁用删除但不禁返回', async () => {
  await render(<Skills.A6 />); await tick();
  await fireEvent.press(screen.getByTestId('skill-source-check')); await tick();
  expect(screen.getByTestId('skill-content')).toBeOnTheScreen();
  expect(screen.getByTestId('skill-delete')).toBeDisabled();
  expect(screen.getByTestId('skill-back')).toBeEnabled();
});

test('settings-skills.A2 E2 同名目录互不覆盖，内置正文可读且使用者可进资料', async () => {
  const view = await render(<Skills.A2Collision />); await tick();
  expect(screen.getByTestId('skill-wandrun-ui')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('builtin-skill-wandrun-ui')); await tick();
  expect(screen.getByTestId('builtin-skill-content')).toHaveTextContent(/交互界面/);
  expect(screen.queryByTestId('skill-delete')).toBeNull();
  await view.unmount();
  await render(<Skills.E2 />); await tick();
  await fireEvent.press(screen.getByTestId('builtin-agent-research')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('研究员');
});

test('settings-skills.D4 T2 列表删除结果：未确认无 ×，核对完成后的结果提示横幅内 × 关闭', async () => {
  const peer = skillsScenario('D4-unknown');
  let deletes = 0;
  peer.gateway.overrides['DELETE /skills/:name'] = () => { deletes++; return jsonResponse({ error: { code: 'unavailable', message: '回执未取得' } }, 503); };
  peer.gateway.overrides['GET /skills/:name'] = () => { if (deletes) return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503); };
  try {
    peer.start(); await tick();
    await render(<SceneProviders path="/settings-skills" routes={{ '/': () => null }}><SkillsList session={peer.session} /></SceneProviders>); await tick();
    const operation = skillDeletion(peer.session, 'source-check');
    await operation.preflight(); await act(async () => { await operation.remove(); }); await tick();
    await tick(3000);
    expect(screen.getByTestId('skills-delete-notice')).toHaveTextContent(/删除结果未确认/);
    expect(screen.queryByTestId('skills-delete-notice-dismiss')).toBeNull();
    delete peer.gateway.overrides['GET /skills/:name'];
    peer.gateway.state.skills = peer.gateway.state.skills.filter(skill => skill.name !== 'source-check');
    await tick(1000);
    expect(screen.getByTestId('skills-delete-notice')).toHaveTextContent('技能已删除');
    await fireEvent.press(screen.getByTestId('skills-delete-notice-dismiss')); await tick();
    expect(screen.queryByTestId('skills-delete-notice')).toBeNull();
    expect(operation.snapshot().phase).toBe('deleted');
  } finally { peer.stop(); await tick(); }
});

test('settings-skills.D4 T2 核对完成的删除结果属于列表这次访问：离开列表即撤销，未确认不撤销', async () => {
  const peer = skillsScenario('D4-unknown');
  let deletes = 0;
  peer.gateway.overrides['DELETE /skills/:name'] = () => { deletes++; return jsonResponse({ error: { code: 'unavailable', message: '回执未取得' } }, 503); };
  peer.gateway.overrides['GET /skills/:name'] = () => { if (deletes) return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503); };
  try {
    peer.start(); await tick();
    const operation = skillDeletion(peer.session, 'source-check');
    await operation.preflight(); await act(async () => { await operation.remove(); }); await tick();
    const unknownView = await render(<SceneProviders path="/settings-skills" routes={{ '/': () => null }}><SkillsList session={peer.session} /></SceneProviders>); await tick();
    await unknownView.unmount(); await tick();
    expect(operation.snapshot().phase).toBe('unknown');
    delete peer.gateway.overrides['GET /skills/:name'];
    peer.gateway.state.skills = peer.gateway.state.skills.filter(skill => skill.name !== 'source-check');
    await tick(1000);
    const view = await render(<SceneProviders path="/settings-skills" routes={{ '/': () => null }}><SkillsList session={peer.session} /></SceneProviders>); await tick();
    expect(screen.getByTestId('skills-delete-notice')).toHaveTextContent('技能已删除');
    await view.unmount(); await tick();
    expect(operation.snapshot().error).toBe('');
  } finally { peer.stop(); await tick(); }
});
