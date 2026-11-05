import type { Meta, StoryObj } from '@storybook/react-native';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { FileDetailScreen } from '../app/files/[id]';
import { FakeGateway } from './fake-gateway';
import { createSceneSession } from './scene-session';
import { SceneProviders } from './scene-providers';
import { FoundationFrame } from './foundation-frame';
import { useMountEffect } from '../lib/use-mount-effect';
import { AlertCircle } from 'lucide-react-native';
import { FileView } from '../components/file-view';
import { StatusBanner } from '../components/status-banner';
import { initialDeliveryState } from '../lib/delivery-action';

function FileStory({ theme = 'light', state = 'text' }: { theme?: 'light' | 'dark'; state?: 'text' | 'unavailable' | 'error' | 'other' }) {
  if (state === 'error') return <GestureHandlerRootView style={{ flex: 1 }}><FoundationFrame theme={theme} scrollable={false}><SceneProviders>
    <FileView loading={false} enabled={false} state={initialDeliveryState} cacheError={null}
      feedback={<StatusBanner icon={AlertCircle} title="无法读取文件信息，正在重试…" />} origin="" preview={null}
      onBack={() => {}} onAction={() => {}} />
  </SceneProviders></FoundationFrame></GestureHandlerRootView>;
  return <FileStoryAccess key={`${theme}:${state}`} theme={theme} state={state} />;
}
function FileStoryAccess({ theme, state }: { theme: 'light' | 'dark'; state: 'text' | 'unavailable' | 'other' }) {
  const peer = useMemo(() => {
    const gateway = new FakeGateway();
    const content = '# 附件正文\n\n通过真实文件接口读取，保留 Markdown 排版。\n\n- 文件打开\n- 返回聊天\n- 保存与分享';
    gateway.state.files.set('original', { id: 'original', name: state === 'other' ? 'archive.zip' : 'project.md', size: new TextEncoder().encode(content).length,
      media_type: state === 'other' ? 'application/zip' : 'text/markdown', conversation_id: null, agent_id: null, task_id: 'root', source: 'user_upload', remote_environment: null, created_at: 1,
      available: state !== 'unavailable', error: state === 'unavailable' ? 'missing' : null, error_message: state === 'unavailable' ? '原文件已不存在' : null });
    gateway.state.fileBytes.set('original', new TextEncoder().encode(content));
    return { gateway, session: createSceneSession({ baseUrl: 'https://files-scene.invalid', token: 'scene', computerId: 'files-scene' }, gateway.fetch) };
  }, [state]);
  useMountEffect(() => { void peer.session.start(); return () => { void peer.session.close(); peer.gateway.disconnect(); }; });
  return <GestureHandlerRootView style={{ flex: 1 }}><FoundationFrame theme={theme} scrollable={false}><SceneProviders>
    <FileDetailScreen session={peer.session} id="original" />
  </SceneProviders></FoundationFrame></GestureHandlerRootView>;
}
const meta = { title: 'files', component: FileStory, parameters: { fullScreen: true } } satisfies Meta<typeof FileStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A4: Story = { name: 'A4 Markdown 文件详情', args: {} };
export const A4Dark: Story = { name: 'A4 Markdown 文件详情（深色）', args: { theme: 'dark' } };
export const A3: Story = { name: 'A3 原文件已不存在', args: { state: 'unavailable' } };
export const A2: Story = { name: 'A2 首次读取失败（视图快照）', args: { state: 'error' } };
export const A5: Story = { name: 'A5 不支持预览的格式', args: { state: 'other' } };
