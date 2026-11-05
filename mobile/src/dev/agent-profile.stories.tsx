import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Uniwind } from 'uniwind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ProfileScreen } from '../app/agents/[id]';
import { AllAgentsScreen } from '../app/agents';
import { MemoryReaderScreen } from '../app/memory-reader';
import { MemoryEditor } from '../app/memory-editor';
import { MemoryDetailScreen } from '../app/memory-detail';
import { AboutYouScreen } from '../app/settings-about-you';
import { ScheduleEditor } from '../app/schedule-editor';
import { ComputerScreen } from '../app/settings-computer';
import ChatRoute from '../app/chat';
import type { MemoryScope } from '../gateway/api';
import { agentProfileScenario, type ProfileScenario, type ProfileScene } from './agent-profile-scenario';
import { SceneProviders } from './scene-providers';
import { useMountEffect } from '../lib/use-mount-effect';
import { SessionProvider, useSession } from '../lib/session-context';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';

function useStorySession() { return useSession()!; }
function ReaderRoute() {
  const session = useStorySession();
  const { scope, id } = useLocalSearchParams<{ scope: MemoryScope; id: string }>();
  return <MemoryReaderScreen key={`${scope}:${id}`} scope={scope} id={id} session={session} />;
}
function EditorRoute() {
  const session = useStorySession();
  const { scope, id } = useLocalSearchParams<{ scope: MemoryScope; id: string }>();
  return <MemoryEditor key={`${scope}:${id}`} scope={scope} id={id} session={session} />;
}
function DetailRoute() {
  const session = useStorySession();
  const { scope, id, slug, create } = useLocalSearchParams<{ scope: MemoryScope; id: string; slug?: string; create?: string }>();
  return <MemoryDetailScreen key={`${scope}:${id}:${slug ?? 'new'}`} scope={scope} id={id} slug={slug} creating={create === '1'} session={session} />;
}
function AboutRoute() { return <AboutYouScreen session={useStorySession()} focused={useIsFocused()} />; }
function ScheduleRoute() {
  const session = useStorySession();
  const { id, agentId } = useLocalSearchParams<{ id: string; agentId: string }>();
  return <ScheduleEditor key={`${agentId}:${id}`} id={id} agentId={agentId} session={session} />;
}
function ComputerRoute() {
  const session = useStorySession();
  return <ComputerScreen session={session} />;
}
function DirectoryRoute() { return <AllAgentsScreen session={useStorySession()} />; }
const routes = { '/': DirectoryRoute, '/memory-reader': ReaderRoute, '/memory-editor': EditorRoute, '/memory-detail': DetailRoute, '/settings-about-you': AboutRoute, '/schedule-editor': ScheduleRoute, '/chat': ChatRoute, '/settings-computer': ComputerRoute };

function ProfileScenePage({ state = 'C3', reading = false, theme = 'light', scenario, settingsComputer = false, aboutYou = false }: { state?: ProfileScene; reading?: boolean; theme?: 'light' | 'dark'; scenario?: ProfileScenario; settingsComputer?: boolean; aboutYou?: boolean }) {
  return <ProfileSceneContent key={`${state}:${reading}:${theme}:${settingsComputer}:${aboutYou}`} state={state} reading={reading} theme={theme} scenario={scenario} settingsComputer={settingsComputer} aboutYou={aboutYou} />;
}
type ProfileSceneVisit = { state: ProfileScene; reading: boolean; theme: 'light' | 'dark'; settingsComputer: boolean; aboutYou: boolean };
function ProfileSceneContent({ scenario, ...visit }: ProfileSceneVisit & { scenario?: ProfileScenario }) {
  const peer = useMemo(() => scenario ?? agentProfileScenario(visit.state), [visit.state, scenario]);
  return <SessionProvider runtime={peer.runtime}><ProfileSceneRuntime peer={peer} {...visit} /></SessionProvider>;
}
function ProfileSceneRuntime(props: ProfileSceneVisit & { peer: ProfileScenario }) {
  const session = useSession();
  return session ? <ProfileSceneRoutes key={session.queryIdentity} {...props} /> : null;
}
function ProfileSceneRoutes({ peer, state, reading, theme, settingsComputer, aboutYou }: ProfileSceneVisit & { peer: ProfileScenario }) {
  const session = useStorySession();
  useMountEffect(() => { void peer.start(session); return peer.stop; });
  useMountEffect(() => {
    const previous = Uniwind.currentTheme;
    Uniwind.setTheme(theme);
    return () => Uniwind.setTheme(previous);
  });
  const location = aboutYou ? '/settings-about-you' : settingsComputer ? '/settings-computer' : state.startsWith('G') ? '/memory-detail?scope=work&id=planner&slug=project'
    : state.startsWith('F1') ? '/memory-editor?scope=work&id=planner'
    : reading ? '/memory-reader?scope=work&id=planner' : '/agents/planner';
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <SceneProviders path="/agents/[id]" location={location} routes={routes}>
      <ProfileScreen id={peer.id} initialTab={state.startsWith('C') ? 'schedules' : state.startsWith('D') ? 'members' : state.startsWith('E') || state.startsWith('F') || state.startsWith('G') ? 'memory' : undefined} session={session} />
    </SceneProviders>
    {state === 'E4Stale' ? <Button intent="soft" onPress={() => peer.changeMemory('远端更新')}><Text>Storybook：模拟记忆更新后读取失败</Text></Button> : null}
  <PortalHost /></GestureHandlerRootView>;
}
const meta = { title: 'agent-profile', component: ProfileScenePage, parameters: { fullScreen: true } } satisfies Meta<typeof ProfileScenePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A6: Story = { name: 'A6 默认浏览器标签', args: { state: 'A6' } };
export const B3: Story = { name: 'B3 等你接管 + 其他页面', args: { state: 'B3' } };
export const B3Dark: Story = { name: 'B3 浏览器活动（深色）', args: { state: 'B3', theme: 'dark' } };
export const B4: Story = { name: 'B4 其他页面 · 左滑关闭页面', args: { state: 'B3' } };
export const C2: Story = { name: 'C2 三条定时 · 启用与停用', args: { state: 'C2' } };
export const C2Dark: Story = { name: 'C2 三条定时（深色）', args: { state: 'C2', theme: 'dark' } };
export const C3: Story = { name: 'C3 无定时', args: { state: 'C3' } };
export const D3: Story = { name: 'D3 无成员', args: { state: 'D3' } };
export const E2: Story = { name: 'E2 两行记忆入口 · 有内容', args: { state: 'E2' } };
export const E2Dark: Story = { name: 'E2 两行记忆入口（深色）', args: { state: 'E2', theme: 'dark' } };
export const E3: Story = { name: 'E3 两行记忆入口 · 无内容', args: { state: 'E3' } };
export const E4: Story = { name: 'E4 两行记忆入口 · 读取失败', args: { state: 'E4' } };
export const E4Recovery: Story = { name: 'E4 读取失败后自动恢复', args: { state: 'E4Recovery' } };
export const E2Reader: Story = { name: 'E2 记忆索引全文阅读', args: { state: 'E2', reading: true } };
export const E2ReaderDark: Story = { name: 'E2 记忆索引全文阅读（深色）', args: { state: 'E2', reading: true, theme: 'dark' } };
export const E3Reader: Story = { name: 'E3 空记忆全文阅读', args: { state: 'E3', reading: true } };
export const F2: Story = { name: 'F2 阅读→全文编辑→保存返回', args: { state: 'F2', reading: true } };
export const F4: Story = { name: 'F4 编辑后保存触发冲突 · 重载保留草稿', args: { state: 'F4', reading: true } };
export const A2: Story = { name: 'A2 资料读取中', args: { state: 'A2' } };
export const A4: Story = { name: 'A4 资料读取失败 · 自动重试', args: { state: 'A4' } };
export const A5: Story = { name: 'A5 连接重试 · 保留资料', args: { state: 'A5' } };
export const B1: Story = { name: 'B1 电脑首次读取', args: { state: 'B1' } };
export const B2: Story = { name: 'B2 电脑空状态', args: { state: 'A6' } };
export const B5: Story = { name: 'B5 电脑读取失败', args: { state: 'B5' } };
export const B6: Story = { name: 'B6 左滑直接关闭 · 在途', args: { state: 'B6' } };
export const B7: Story = { name: 'B7 关闭失败 · 可重试', args: { state: 'B7' } };
export const C1: Story = { name: 'C1 定时首次读取', args: { state: 'C1' } };
export const C4: Story = { name: 'C4 定时读取失败', args: { state: 'C4' } };
export const C5: Story = { name: 'C5 点开关后更新中', args: { state: 'C5' } };
export const C5Failure: Story = { name: 'C5 更新失败保留列表', args: { state: 'C5Failure' } };
export const C6: Story = { name: 'C6 已结束的单次定时', args: { state: 'C6' } };
export const C7: Story = { name: 'C7 已有定时编辑与删除', args: { state: 'C7' } };
export const C8: Story = { name: 'C8 开关结果未确认 · 点每周复盘开关', args: { state: 'C8' } };
export const D1: Story = { name: 'D1 成员读取中', args: { state: 'D1' } };
export const D2: Story = { name: 'D2 一个成员 · 进入聊天', args: { state: 'D2' } };
export const D2Dark: Story = { name: 'D2 成员（深色）', args: { state: 'D2', theme: 'dark' } };
export const D2Many: Story = { name: 'D2 多成员可滚动', args: { state: 'D2Many' } };
export const D4: Story = { name: 'D4 部分成员资料缺失', args: { state: 'D4' } };
export const D5: Story = { name: 'D5 打开成员聊天失败', args: { state: 'D5' } };
export const E1: Story = { name: 'E1 记忆入口读取中仍可点', args: { state: 'E1' } };
export const E2Long: Story = { name: 'E2 长名字与摘要', args: { state: 'E2Long' } };
export const E4Stale: Story = { name: 'E4 已有快照后读取失败', args: { state: 'E4Stale' } };
export const F1: Story = { name: 'F1 全文编辑读取中', args: { state: 'F1' } };
export const F3: Story = { name: 'F3 编辑后保存失败 · 草稿保留', args: { state: 'F3', reading: true } };
export const G1: Story = { name: 'G1 详情首次读取', args: { state: 'G1' } };
export const G2: Story = { name: 'G2 受管详情阅读 · 编辑与删除', args: { state: 'G2' } };
export const G4: Story = { name: 'G4 详情编辑保存失败', args: { state: 'G4' } };
export const G5: Story = { name: 'G5 详情保存冲突保留草稿', args: { state: 'G5' } };
export const G7: Story = { name: 'G7 删除详情失败保留索引核对', args: { state: 'G7' } };
export const F1Failure: Story = { name: 'F1 全文编辑读取失败 · 自动重试', args: { state: 'F1Failure' } };
export const F5: Story = { name: 'F5 冲突后重新加载失败 · 草稿仍在', args: { state: 'F5', reading: true } };
export const G1Failure: Story = { name: 'G1 详情读取失败 · 自动重试', args: { state: 'G1Failure' } };
export const B3Settings: Story = { name: 'B3 设置电脑 · 直接关闭', args: { state: 'B3', settingsComputer: true } };
export const B6Settings: Story = { name: 'B6 设置电脑 · 关闭在途', args: { state: 'B6', settingsComputer: true } };
export const B7Settings: Story = { name: 'B7 设置电脑 · 关闭失败就地反馈', args: { state: 'B7', settingsComputer: true } };
export const AboutYouContent: Story = { name: 'AY1 关于你 · 有内容 · 顶栏编辑', args: { state: 'E2', aboutYou: true } };
export const AboutYouEmpty: Story = { name: 'AY1 关于你 · 无内容 · 顶栏编辑', args: { state: 'E3', aboutYou: true } };
