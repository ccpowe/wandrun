import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { AlertCircle, WifiOff, X } from 'lucide-react-native';

import { StatusBanner } from '@/components/status-banner';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

/** 读取类横幅自动恢复、无操作；就地提示带横幅内右侧 ×（design.md §6）。 */
function Banners({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [notice, setNotice] = useState(true);
  return <FoundationFrame theme={theme}>
    <View className="gap-2 py-4">
      <StatusBanner icon={WifiOff} title="连接断开，正在重连…" accessibilityRole="alert" />
      <StatusBanner icon={AlertCircle} title="无法加载对话，正在重试…" description="内容可能不是最新的" />
      {notice
        ? <StatusBanner icon={AlertCircle} title="无法添加附件" description="无法读取所选文件" accessibilityRole="alert"
          action={{ icon: X, label: '关闭提示', onPress: () => setNotice(false), testID: 'status-banner-dismiss' }} />
        : <View className="mx-4 items-start"><Button intent="soft" size="sm" onPress={() => setNotice(true)}><Text>再次显示就地提示</Text></Button></View>}
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/StatusBanner', component: Banners, parameters: { fullScreen: true } } satisfies Meta<typeof Banners>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: '读取横幅 + 就地提示 × · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: '读取横幅 + 就地提示 × · 深色', args: { theme: 'dark' } };
