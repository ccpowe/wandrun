import type { Meta, StoryObj } from '@storybook/react-native';
import { SceneProviders } from '../dev/scene-providers';
import { ChatSession } from '../gateway/session';
import { ConnectionBanner } from './connection-banner';

export function bannerSession(connection: ChatSession['connection'], notice: string | null = null) {
  const result = new ChatSession({ baseUrl: 'https://gallery.invalid', token: 'gallery' });
  result.connection = connection;
  result.notice = notice;
  return result;
}
const meta = {
  title: 'ConnectionBanner',
  component: ConnectionBanner,
  decorators: [(Story) => <SceneProviders><Story /></SceneProviders>],
  excludeStories: ['bannerSession'],
} satisfies Meta<typeof ConnectionBanner>;
export default meta;
type Story = StoryObj<typeof meta>;
export const hidden: Story = { args: { session: bannerSession('open') } };
export const reconnecting: Story = { args: { session: bannerSession('reconnecting') } };
export const error: Story = { args: { session: bannerSession('error', '连不上网关') } };
