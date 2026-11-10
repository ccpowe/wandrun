import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { CleanupResultNotice } from '../components/cleanup-result-notice';
import { EnvironmentSwitchConfirmation } from '../components/editor-leave-sheet';
import { Text } from '../components/ui/text';
import { SceneProviders } from './scene-providers';

/** ADR-0089 step 1 user-visible states, for on-device copy review. */
function NoticeStory({ message }: { message: string }) {
  return <SceneProviders><View className="flex-1 gap-3 bg-background px-4 pt-16">
    <CleanupResultNotice message={message} />
    <Text className="text-muted-foreground">（落点页内容）</Text>
  </View></SceneProviders>;
}

function ConfirmStory() {
  const [last, setLast] = useState('');
  return <SceneProviders><View className="flex-1 bg-background px-4 pt-16">
    <Text className="text-muted-foreground">编辑 Agent · 已把执行环境改为另一台机器，点保存后：</Text>
    <Text className="mt-2">{last}</Text>
    <EnvironmentSwitchConfirmation open disabled={false}
      onCancel={() => setLast('已取消：不提交、不停止')} onConfirm={() => setLast('已确认：停止并切换')} />
    <PortalHost />
  </View></SceneProviders>;
}

const meta = { title: 'ADR-0089/沙箱清理告知' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SwitchConfirm: Story = { name: '切换执行环境确认', render: () => <ConfirmStory /> };
export const DeletedResidue: Story = { name: '删除后远端残留告知',
  render: () => <NoticeStory message="已删除；远端未能清理，可能残留目录或进程。可让 Agent 连上后自行清理，或销毁沙箱。" /> };
export const SwitchedResidue: Story = { name: '切换后旧环境残留告知',
  render: () => <NoticeStory message="执行环境已切换；旧环境可能残留目录或进程。" /> };
