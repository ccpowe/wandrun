import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { GatewayConnectionView } from '../components/gateway-connection-view';
import { Text } from '../components/ui/text';
import type { SavedComputer } from '../lib/credentials';
import { selectConnectionAction, type ConnectionActionState } from '../lib/gateway-connection';
import { FoundationFrame, type FoundationTheme } from './foundation-frame';
import { SceneProviders } from './scene-providers';

const computer: SavedComputer = { computerId: 'server', connectionId: 'visit', baseUrl: 'http://127.0.0.1:18787', token: 'story', computerName: '研究服务器', gatewayVersion: '0.2.0', pairingMethod: 'manual' };
function ConnectionViewStory({ state, theme = 'light' }: { state: ConnectionActionState; theme?: FoundationTheme }) {
  const [lastAction, setLastAction] = useState('');
  const record = (action: string) => () => setLastAction(action);
  return <FoundationFrame theme={theme} scrollable={false}><SceneProviders><View className="flex-1">
    <GatewayConnectionView session={null} config={computer} computers={[computer]} details={undefined} readError={false} pending={false} connectionLabel={null} appVersion="1.0.0"
      action={selectConnectionAction(state)} onBack={record('返回')} onSelect={record('切换')} onAdd={record('添加')} onRepair={record('重新配对')}
      onRename={record('备注')} onDisconnect={record('断开')} onName={name => setLastAction(name)} onCancel={record('取消')} onConfirm={record('确认')} />
    {lastAction ? <Text variant="caption">Storybook: {lastAction}</Text> : null}<PortalHost />
  </View></SceneProviders></FoundationFrame>;
}
const meta = { title: 'gateway-connection-view', component: ConnectionViewStory, parameters: { fullScreen: true } } satisfies Meta<typeof ConnectionViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const D4: Story = { name: 'D4 视图 · 备注持久化中', args: { state: { status: 'saving-name', targetId: 'server', draft: '研究服务器', operationId: 'save' } } };
export const D5: Story = { name: 'D5 视图 · 备注保存失败（深色）', args: { theme: 'dark', state: { status: 'rename', targetId: 'server', draft: '新的备注', error: '无法保存备注名，请重试。' } } };
export const D6: Story = { name: 'D6 视图 · 本地移除中', args: { state: { status: 'disconnecting', targetId: 'server', operationId: 'remove' } } };
