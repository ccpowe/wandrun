import type { Meta, StoryObj } from '@storybook/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MediaViewerScreen } from '../app/media-viewer';
import { FoundationFrame } from './foundation-frame';
import { SceneProviders } from './scene-providers';

function ViewerStory({ theme = 'light', invalid = false }: { theme?: 'light' | 'dark'; invalid?: boolean }) {
  return <GestureHandlerRootView style={{ flex: 1 }}><FoundationFrame theme={theme} scrollable={false}><SceneProviders>
    <MediaViewerScreen params={invalid ? {} : {
      file_id: 'attachment-preview-image-2',
      file_ids: JSON.stringify(['attachment-preview-image-1', 'attachment-preview-image-2', 'attachment-preview-image-3']),
      index: '1',
    }} />
  </SceneProviders></FoundationFrame></GestureHandlerRootView>;
}
const meta = { title: 'media-viewer', component: ViewerStory, parameters: { fullScreen: true } } satisfies Meta<typeof ViewerStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const B1: Story = { name: 'B1 附件相册，从第二张开始', args: {} };
export const B1Dark: Story = { name: 'B1 附件相册（深色）', args: { theme: 'dark' } };
export const A1: Story = { name: 'A1 媒体已不可用', args: { invalid: true } };
