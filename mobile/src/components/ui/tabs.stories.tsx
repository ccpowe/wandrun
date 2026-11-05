import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

const sections = [ ['browser', '浏览器'], ['schedules', '定时'], ['members', '成员'], ['memory', '记忆'] ] as const;
function Segments({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [tab, setTab] = useState('memory');
  const [defaultTab, setDefaultTab] = useState('one');
  return <FoundationFrame theme={theme}>
    <View className="gap-5 bg-page-surface p-4">
      <Text variant="caption" className="text-muted-foreground">Text Segment · 13px 常规 / 48 触区 / 无图标描边</Text>
      <Tabs variant="text-segment" value={tab} onValueChange={setTab}>
        <TabsList>{sections.map(([value, label]) => <TabsTrigger key={value} value={value}><Text>{label}</Text></TabsTrigger>)}</TabsList>
        {sections.map(([value, label]) => <TabsContent key={value} value={value}><View className="mt-4 rounded-lg bg-card p-4"><Text variant="body">{label}内容</Text></View></TabsContent>)}
      </Tabs>
      <Text variant="caption" className="text-muted-foreground">只在 Tabs 根设置 variant，List/Trigger 自动继承；选择仍由 rn-primitives 管理。</Text>
      <Text variant="caption" className="text-muted-foreground">省略 variant · 默认即 Text Segment</Text>
      <Tabs value={defaultTab} onValueChange={setDefaultTab}><TabsList><TabsTrigger value="one"><Text>默认选中</Text></TabsTrigger><TabsTrigger value="two"><Text>默认未选</Text></TabsTrigger></TabsList></Tabs>
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/Tabs', component: Segments, parameters: { fullScreen: true } } satisfies Meta<typeof Segments>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Text Segment · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Text Segment · 深色', args: { theme: 'dark' } };
