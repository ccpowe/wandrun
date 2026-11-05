import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

function Inputs({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [name, setName] = useState('我的服务器');
  const [saved, setSaved] = useState('');
  return <FoundationFrame theme={theme}>
    <View className="gap-5 p-4">
      <View className="gap-2"><Text variant="caption" className="text-muted-foreground">页底字段 · filled / card · 15/20</Text><Input variant="filled" accessibilityLabel="服务器名称" value={name} onChangeText={setName} placeholder="名称" /></View>
      <View className="gap-2 rounded-lg bg-card p-4"><Text variant="caption" className="text-muted-foreground">分组内字段 · filled / muted</Text><Input variant="filled" tone="muted" accessibilityLabel="远程地址" defaultValue="https://example.com/mcp" autoCapitalize="none" keyboardType="url" /><Input variant="filled" tone="muted" accessibilityLabel="请求头密钥" secureTextEntry placeholder="输入密钥" /></View>
      <View className="gap-2"><Text variant="caption" className="text-muted-foreground">禁用 · 保留原生输入行为</Text><Input variant="filled" accessibilityLabel="禁用名称" editable={false} value="只读名称" /></View>
      <Button intent="primary" disabled={!name.trim()} onPress={() => setSaved(name.trim())}><Text>保存名称</Text></Button>
      {saved ? <Text variant="caption" accessibilityLiveRegion="polite">已保存：{saved}</Text> : null}
      <View className="gap-2"><Text variant="caption" className="text-muted-foreground">省略 variant · 默认即 Filled / Card</Text><Input accessibilityLabel="默认字段" placeholder="默认 Input" /></View>
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/Input', component: Inputs, parameters: { fullScreen: true } } satisfies Meta<typeof Inputs>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Filled · Card + Muted · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Filled · Card + Muted · 深色', args: { theme: 'dark' } };
