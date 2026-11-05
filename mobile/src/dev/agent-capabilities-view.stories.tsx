import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useReducer } from 'react';
import { AgentCapabilitiesView } from '../components/agent-capabilities-view';
import type { AgentCapability } from '../gateway/api';
import { capabilityReducer, selectCapabilities } from '../lib/agent-capabilities-state';
import { FoundationFrame } from './foundation-frame';
import { SceneProviders } from './scene-providers';

const capability: AgentCapability = { id: 'files', name: '文件', summary: '读写工作目录', description: '读写这个 Agent 所在电脑上的文件，相对路径落在当前对话的目录里。', status: 'enabled', reason: '所有 Agent 均可使用', tools: ['read_file', 'write_file'], skills: [] };
function DetailStory({ theme = 'light', failed = false }: { theme?: 'light' | 'dark'; failed?: boolean }) {
  const [state, dispatch] = useReducer(capabilityReducer, { status: 'details', id: 'files' });
  return <FoundationFrame theme={theme} scrollable={false}><SceneProviders>
    <AgentCapabilitiesView selection={selectCapabilities(state, [capability], failed ? 'failed' : '', 'idle')}
      readError={failed} connectionBanner={null} onBack={() => dispatch({ type: 'close' })}
      onOpen={id => dispatch({ type: 'open', id })} onClose={() => dispatch({ type: 'close' })} />
    <PortalHost />
  </SceneProviders></FoundationFrame>;
}
const meta = { title: 'agent-capabilities-view', component: DetailStory, parameters: { fullScreen: true } } satisfies Meta<typeof DetailStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const G3: Story = { name: 'G3 详情', args: {} };
export const G3Dark: Story = { name: 'G3 详情（深色）', args: { theme: 'dark' } };
export const G4Stale: Story = { name: 'G4 刷新失败保留可读详情', args: { failed: true } };
