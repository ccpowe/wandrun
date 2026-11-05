import type { Meta, StoryObj } from '@storybook/react-native';
import { View } from 'react-native';
import { Uniwind } from 'uniwind';

import { ChatLocalNoticeView, ChatNotices } from './chat-notices';
import type { ChatLocalNotice, ChatNotice } from '../../lib/chat-notices';
import { useMountEffect } from '../../lib/use-mount-effect';

/** View-only states that are hard to reach on the page: one banner plus the local hint under it. */
function NoticePreview({ theme, banner, notice }: { theme: 'light' | 'dark'; banner?: ChatNotice; notice: ChatLocalNotice }) {
  return <Themed key={theme} theme={theme}>
    <View className="flex-1 gap-2 bg-background pt-16">
      {banner && <ChatNotices notices={[banner]} onRetryStop={() => {}} />}
      <ChatLocalNoticeView notice={notice} onDismiss={() => {}} />
    </View>
  </Themed>;
}
function Themed({ theme, children }: { theme: 'light' | 'dark'; children: React.ReactNode }) {
  useMountEffect(() => {
    const previous = Uniwind.currentTheme;
    Uniwind.setTheme(theme);
    return () => Uniwind.setTheme(previous);
  });
  return children;
}

const meta = { title: 'chat/LocalNotice', component: NoticePreview } satisfies Meta<typeof NoticePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
const send: ChatLocalNotice = { kind: 'send', title: '无法发送', description: '无法发送消息，草稿仍在，请重试' };
const missing: ChatLocalNotice = { kind: 'missing', title: '消息不存在', description: '已加载全部历史，未找到目标消息。' };
const offline: ChatNotice = { kind: 'offline', message: '连接断开，正在重连…' };

export const G7Send: Story = { name: 'G7 发送失败 · 浅色', args: { theme: 'light', notice: send } };
export const G7UnderBanner: Story = { name: 'G7 横幅下方 · 深色', args: { theme: 'dark', banner: offline, notice: send } };
export const C7Missing: Story = { name: 'C7 消息不存在 · 深色', args: { theme: 'dark', notice: missing } };
