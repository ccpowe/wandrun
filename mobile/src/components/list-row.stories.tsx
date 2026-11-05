import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { CalendarClock, GitBranch } from 'lucide-react-native';

import { ListRow, RowSubtitle } from '@/components/list-row';
import { WandrunAvatar } from '@/components/wandrun-avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

const conversations = [
  { title: '今天有哪些值得关注的 AI 新闻', agent: '资讯主编', avatar: 2, time: '10:42' },
  { title: '帮我读懂这篇论文', agent: '研究员', avatar: 0, time: '09:18' },
  { title: '整理本周的阅读清单', agent: '执行者', avatar: 4, time: '08:56' },
];
function DrawerRows({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState('长按对话打开操作入口');
  return <FoundationFrame theme={theme}>
    <View className="bg-background py-4">
      <Text variant="caption" className="mb-4 px-6 text-muted-foreground">Drawer · 72 最小高 / 行间 4 / 选中 secondary</Text>
      <Text className="px-6 pb-2 text-xs text-muted-foreground">今天</Text>
      {conversations.map((conversation, index) => <ListRow key={conversation.title} density="drawer" title={conversation.title} selected={selected === index}
        onPress={() => setSelected(index)} onLongPress={() => setMessage(`对话操作：${conversation.title}`)} alert={index === 0}
        subtitle={<><WandrunAvatar index={conversation.avatar} alt={conversation.agent} size={18} className="size-4" /><Text numberOfLines={1} className="shrink">{conversation.agent} · {conversation.time}</Text><Icon as={CalendarClock} accessibilityLabel="定时触发" size={13} className="text-muted-foreground" /><View accessible accessibilityLabel="3 次协作" className="flex-row items-center gap-0.5"><Icon as={GitBranch} size={13} className="text-muted-foreground" /><Text>3</Text></View></>} />)}
      <Text variant="caption" accessibilityLiveRegion="polite" className="px-6 py-4 text-muted-foreground">{message}</Text>
      <ListRow density="drawer" title="按下反馈预览" pressedPreview onPress={() => setMessage('已点按预览行')} subtitle={<Text>只叠表面，不淡化文字或底色</Text>} />
      <Text variant="caption" className="px-6 py-4 text-muted-foreground">普通行默认 compact 密度</Text>
      <ListRow leading={<WandrunAvatar index={0} alt="研究员" size={40} />} title="普通 compact 双行" subtitle={<RowSubtitle text="首页与资料页的双行结构" />} />
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/ListRow', component: DrawerRows, parameters: { fullScreen: true } } satisfies Meta<typeof DrawerRows>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Drawer Density · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Drawer Density · 深色', args: { theme: 'dark' } };
