import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { Bell, Globe, Lock, Settings } from 'lucide-react-native';

import { GroupRow } from '@/components/group-row';
import { ListGroup } from '@/components/list-group';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

function Groups({ theme = 'light', divider = 'inset' }: { theme?: FoundationTheme; divider?: 'inset' | 'gap' }) {
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState('none');
  const [enabled, setEnabled] = useState(true);
  const [notice, setNotice] = useState('点按导航行或长按按下示例');
  return <FoundationFrame theme={theme}>
    <Text variant="caption" className="px-8 pt-4 text-muted-foreground">{notice}</Text>
    <ListGroup label="填充分组 · 单行 50 / 双行 60" surface="filled" divider={divider}>
      <GroupRow icon={Settings} title="设置" affordance="navigate" onPress={() => setNotice('已点按导航行')} />
      <GroupRow icon={Globe} title="连接器" description="管理远程服务与本地命令" value="3 个" affordance="navigate" onPress={() => setNotice('已点按连接器')} />
      <GroupRow icon={Lock} title="高级设置" affordance="disclose" expanded={expanded} onPress={() => setExpanded(!expanded)} />
      {expanded ? <GroupRow title="超时时间" value="30 秒" /> : null}
      <GroupRow icon={Bell} title="通知" trailing={<Switch accessibilityLabel="通知" checked={enabled} onCheckedChange={setEnabled} />} />
      <GroupRow title="服务器版本（只读）" value="1.0.0" />
    </ListGroup>
    <ListGroup label="认证 · 无图标分隔线从 16 开始" surface="filled" divider={divider} inset="content">
      <GroupRow title="无需认证" affordance="selected" selected={selection === 'none'} onPress={() => setSelection('none')} />
      <GroupRow title="密钥请求头" affordance="selected" selected={selection === 'key'} onPress={() => setSelection('key')} />
      <GroupRow title="OAuth" affordance="selected" selected={selection === 'oauth'} onPress={() => setSelection('oauth')} />
    </ListGroup>
    <ListGroup label="表面按下反馈 · 保留底色与文字" surface="filled" divider={divider}>
      <GroupRow icon={Settings} title="按下预览（可长按）" pressedPreview onPress={() => setNotice('已点按预览行')} onLongPress={() => setNotice('已长按预览行')} />
      <GroupRow icon={Globe} title="读取中" loading />
      <GroupRow icon={Bell} title="需要处理" alert description="错误或未读提示不改变行的填充" />
    </ListGroup>
    <View className="mt-6"><ListGroup label="省略 surface · 默认即填充分组"><View className="p-4"><Text variant="body">正式页面直接使用同一套新风格</Text></View></ListGroup></View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/ListGroup + GroupRow', component: Groups, parameters: { fullScreen: true } } satisfies Meta<typeof Groups>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InsetLight: Story = { name: 'Filled + Inset + Affordance · 浅色', args: { theme: 'light' } };
export const InsetDark: Story = { name: 'Filled + Inset + Affordance · 深色', args: { theme: 'dark' } };
export const GapLight: Story = { name: 'Filled + Gap + Surface 反馈 · 浅色', args: { theme: 'light', divider: 'gap' } };
export const GapDark: Story = { name: 'Filled + Gap + Surface 反馈 · 深色', args: { theme: 'dark', divider: 'gap' } };
