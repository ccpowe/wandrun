import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import type { DrawerConversation } from '@/components/chat/conversation-drawer';
import { DrawerPanelView } from '@/components/chat/conversation-drawer-view';
import { Text } from '@/components/ui/text';
import { groupDrawerConversations } from '@/lib/drawer-dates';
import { selectDrawerOverlay, type DrawerOverlay } from '@/lib/drawer-overlay';
import { FoundationFrame, type FoundationTheme } from './foundation-frame';
import { SceneProviders } from './scene-providers';

const now = new Date(2026, 9, 31, 12);
const activity = (days: number, hour: number) => new Date(2026, 9, 31 - days, hour).getTime() / 1000;
const agents = [{ id: 'assistant', name: '小万', avatar: 0 }, { id: 'researcher', name: '研究员', avatar: 1 }, { id: 'coder', name: '代码搭档', avatar: 2 }];
const row = (id: string, title: string, activityAt: number | null, extras: Partial<DrawerConversation> = {}): DrawerConversation => ({
  id, title, activityAt, unread: false, running: false, agent: agents[0], collaborationCount: 0, ...extras,
});
const conversations = [
  row('pending', '首条消息发送失败，还没有网关确认的活动时间', null),
  row('today-main', '今天有哪些值得关注的 AI 新闻', activity(0, 10), { source: 'schedule', collaborationCount: 6 }),
  row('today-long', '这是一个很长的对话标题：从一次输入理解异步任务、取消、恢复与 Agent Runtime 的完整执行路径', activity(0, 9), { agent: agents[1], collaborationCount: 2, unread: true }),
  row('yesterday-code', '做一个轻量的个人主页', activity(1, 21), { agent: agents[2], collaborationCount: 4, running: true }),
  row('yesterday-brief', '早间科技简报', activity(1, 7), { source: 'schedule', collaborationCount: 3 }),
  row('older', '旅行前要准备什么', activity(3, 15)),
];
const manyConversations = [...conversations, ...Array.from({ length: 24 }, (_, index) =>
  row(`older-${index}`, `阅读记录 ${index + 1}：比较 Agent 的状态与资源持有者`, activity(4 + index, 10), { agent: agents[index % agents.length] }))];
const drawerVisit = {};
const target = { id: 'today-main', title: '今天有哪些值得关注的 AI 新闻', drawerVisit };
const menuVisit = {};
const menu: DrawerOverlay = { status: 'menu', target, menuVisit, point: { pageX: 28, pageY: 320 } };
const renameFailed: DrawerOverlay = { status: 'renaming', target, title: '修改后的名字', error: '重命名失败，请重试' };
const deleteFailed: DrawerOverlay = { status: 'delete-confirm', target, error: '删除失败，请重试' };

/** Fixed view states record actions, like agent-editor-view; normal workflows remain whole-page stories. */
function ViewStory({ theme = 'light', overlay = { status: 'closed' }, many = false, offline = false, loadError }: {
  theme?: FoundationTheme; overlay?: DrawerOverlay; many?: boolean; offline?: boolean; loadError?: string;
}) {
  const [lastAction, setLastAction] = useState('');
  const selection = selectDrawerOverlay(overlay, { open: true, connected: !offline, hasTarget: true, menuVisit, drawerVisit });
  return <GestureHandlerRootView style={{ flex: 1 }}><SceneProviders><FoundationFrame theme={theme} scrollable={false}>
    <View className="w-full max-w-lg flex-1 self-center">
      <DrawerPanelView agents={agents} connected={!offline} groups={groupDrawerConversations(many ? manyConversations : conversations, now)}
        currentId="today-main" now={now} insets={{ top: 0, bottom: 0 }} loadError={loadError}
        onNavigate={name => setLastAction(`打开 ${name}`)} onSelect={id => setLastAction(`选择 ${id}`)}
        onMenu={conversation => setLastAction(`长按 ${conversation.id}`)} onNewConversation={() => setLastAction('新对话')}
        overlays={{ ...selection, host: 'drawer-view', onRename: () => setLastAction('重命名'), onDelete: () => setLastAction('删除'),
          onDismissMenu: () => setLastAction('关闭菜单'), onCancel: () => setLastAction('取消'),
          onRenameClosing: () => { setLastAction('开始关闭面板'); return true; }, onRenameClosed: () => setLastAction('面板已关闭'),
          onChange: title => setLastAction(`修改 ${title}`), onSubmit: async () => { setLastAction('提交'); return false; } }} />
      {lastAction ? <Text variant="caption" className="px-4 py-2 text-muted-foreground">Storybook：{lastAction}</Text> : null}
      <PortalHost name="drawer-view" />
    </View>
  </FoundationFrame></SceneProviders></GestureHandlerRootView>;
}

const meta = { title: 'conversation-drawer-view', component: ViewStory, parameters: { fullScreen: true } } satisfies Meta<typeof ViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dates: Story = { name: 'A 日期分组 · 未确认置顶、长标题与图标', args: {} };
export const DatesDark: Story = { name: 'A 日期分组 · 深色', args: { theme: 'dark' } };
export const LongList: Story = { name: 'E4 正式多行滚动', args: { many: true } };
export const LongListDark: Story = { name: 'E4 正式多行滚动 · 深色', args: { many: true, theme: 'dark' } };
export const Menu: Story = { name: 'C3 正式长按菜单', args: { overlay: menu } };
export const MenuDark: Story = { name: 'C3 正式长按菜单 · 深色', args: { overlay: menu, theme: 'dark' } };
export const RenameFailed: Story = { name: 'C5 重命名失败 · 就地错误与保留草稿', args: { overlay: renameFailed } };
export const RenameFailedDark: Story = { name: 'C5 重命名失败 · 深色', args: { overlay: renameFailed, theme: 'dark' } };
export const Saving: Story = { name: 'C5 正在保存 · 防重复提交', args: { overlay: { status: 'saving', target, title: '修改后的名字', operationId: 'save-1' } } };
export const DeleteFailed: Story = { name: 'C7 删除失败 · 确认内显示错误', args: { overlay: deleteFailed } };
export const DeleteFailedDark: Story = { name: 'C7 删除失败 · 深色', args: { overlay: deleteFailed, theme: 'dark' } };
export const Deleting: Story = { name: 'C7 正在删除 · 禁止取消', args: { overlay: { status: 'deleting', target, operationId: 'delete-1' } } };
export const OfflineDraft: Story = { name: 'E5 离线保留表单、禁止提交', args: { overlay: renameFailed, offline: true } };
export const CollaborationFailed: Story = { name: 'A4 协作读取失败 · 保留现有列表', args: { loadError: 'HTTP 503' } };
