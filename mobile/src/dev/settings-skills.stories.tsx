import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SkillsList } from '../app/settings-skills';
import { SkillDetailScreen } from '../app/skill-detail';
import { BuiltinDetailScreen } from '../app/builtin-skill-detail';
import { ProfileScreen } from '../app/agents/[id]';
import { Text } from '../components/ui/text';
import { SceneProviders } from './scene-providers';
import { skillsScenario, type SkillsSceneState } from './skills-scenario';
import { useMountEffect } from '../lib/use-mount-effect';

function SkillsScene({ state }: { state: SkillsSceneState }) {
  return <SkillsContent key={state} state={state} />;
}
function SkillsContent({ state }: { state: SkillsSceneState }) {
  const peer = useMemo(() => skillsScenario(state), [state]);
  useMountEffect(() => { peer.start(); return peer.stop; });
  const routes = useMemo(() => ({
    '/': () => <Text>设置</Text>,
    '/settings-skills': () => <SkillsList session={peer.session} />,
    '/skill-detail': function Detail() {
      const { name } = useLocalSearchParams<{ name: string }>();
      return <SkillDetailScreen name={name} session={peer.session} />;
    },
    '/builtin-skill-detail': function BuiltinDetail() {
      const { name } = useLocalSearchParams<{ name: string }>();
      return <BuiltinDetailScreen name={name} session={peer.session} />;
    },
    '/agents/[id]': function AgentProfile() {
      const { id } = useLocalSearchParams<{ id: string }>();
      return <ProfileScreen id={id} session={peer.session} />;
    },
  }), [peer]);
  const builtin = state.startsWith('E');
  const detail = builtin || state.startsWith('D') || ['C1', 'C2', 'C3', 'C5'].includes(state);
  const name = builtin ? 'wandrun-ui' : state === 'D2' ? 'notes' : 'source-check';
  const detailPath = builtin ? '/builtin-skill-detail' : '/skill-detail';
  const sceneRoutes = useMemo(() => Object.fromEntries(Object.entries(routes)
    .filter(([path]) => path !== (detail ? detailPath : '/settings-skills'))), [routes, detail, detailPath]);
  return <GestureHandlerRootView style={{ flex: 1 }}><SceneProviders key={state} path={detail ? detailPath : '/settings-skills'}
    location={detail ? `${detailPath}?name=${name}` : '/settings-skills'}
    routes={sceneRoutes}>
    {builtin ? <BuiltinDetailScreen name={name} session={peer.session} /> : detail ? <SkillDetailScreen name={name} session={peer.session} /> : <SkillsList session={peer.session} />}
  </SceneProviders><PortalHost /></GestureHandlerRootView>;
}
const meta = { title: 'settings-skills', component: SkillsScene, parameters: { fullScreen: true } } satisfies Meta<typeof SkillsScene>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A2: Story = { name: 'A2 列表无加号与导入提示', args: { state: 'A2' } };
export const A4: Story = { name: 'A4 读取失败单横幅与自动重试', args: { state: 'A4' } };
export const D4Failed: Story = { name: 'D4 明确删除失败（点删除并确认）', args: { state: 'D4-failed' } };
export const D4Unknown: Story = { name: 'D4 删除结果未确认（点删除并确认）', args: { state: 'D4-unknown' } };
export const D2: Story = { name: 'D2 两个 Agent 使用（点删除看拒绝提示）', args: { state: 'D2' } };
export const C4Many: Story = { name: 'C4 五个 Agent 使用（从 notes 进入详情）', args: { state: 'C4Many' } };
export const C1: Story = { name: 'C1 详情首次读取失败', args: { state: 'C1' } };
export const C3: Story = { name: 'C3 技能正文不可读', args: { state: 'C3' } };
export const C4Long: Story = { name: 'C4 较多 Agent（弹层内滚动）', args: { state: 'C4Long' } };
export const A1: Story = { name: 'A1 我的目录读取中，内置独立展示', args: { state: 'A1' } };
export const A3: Story = { name: 'A3 我的技能为空', args: { state: 'A3' } };
export const A5: Story = { name: 'A5 坏技能仍可进入详情', args: { state: 'A5' } };
export const C2: Story = { name: 'C2 正文与修改时间，无使用者', args: { state: 'C2' } };
export const C4Single: Story = { name: 'C4 单人直接进入资料', args: { state: 'C4Single' } };
export const C5: Story = { name: 'C5 技能已不存在，自动回目录', args: { state: 'C5' } };
export const D3: Story = { name: 'D3 无人使用，确认或取消删除', args: { state: 'D3' } };
export const D4Conflict: Story = { name: 'D4 T1 确认后被使用，服务端拒绝', args: { state: 'D4-conflict' } };
export const E1: Story = { name: 'E1 内置详情读取失败自动重试', args: { state: 'E1' } };
export const E2: Story = { name: 'E2 内置详情只读', args: { state: 'E2' } };
export const E3: Story = { name: 'E3 内置技能不存在，自动回目录', args: { state: 'E3' } };
export const A6: Story = { name: 'A6 离线保留可读内容，删除禁用', args: { state: 'A6' } };
export const A2Collision: Story = { name: 'A2 内置技能与同名我的技能独立', args: { state: 'A2Collision' } };
