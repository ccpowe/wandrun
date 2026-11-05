import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, fromScenario, node } from './rich-fixtures';
import { RichStory } from './rich-story';

const meta = {
  title: 'rich/05 媒体与链接', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
  args: { fixture: fromScenario('image', 'Image') },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Image: Story = { name: 'Image · 本地附件' };
export const UnavailableImage: Story = { name: 'Image · 附件不可用', args: { fixture: fixture(node('Image', { attachment: 'missing.png', alt: '缺失的图片附件' })) } };
export const MediaCard: Story = { name: 'MediaCard · 横排图文', args: { fixture: fromScenario('media-layout', 'MediaCard') } };
export const VerticalMediaCard: Story = { name: 'MediaCard · 竖排图文', args: { fixture: fromScenario('media-layout', 'MediaCard', 1) } };
export const Gallery: Story = { name: 'Gallery · 三张横滑', args: { fixture: fromScenario('media-layout', 'Gallery') } };
export const TwoImageGallery: Story = { name: 'Gallery · 两张并排', args: { fixture: fromScenario('showcase', 'Gallery') } };
export const Source: Story = { name: 'Source · 默认折叠与展开', args: { fixture: fromScenario('sources', 'Source') } };
export const LinkCard: Story = { name: 'LinkCard · 站点字母回退', args: { fixture: fromScenario('sources', 'LinkCard') } };
export const LinkCardWithImage: Story = { name: 'LinkCard · 有图片字段仍离线回退', args: { fixture: fromScenario('link-list-v3', 'LinkCard') } };
export const LongLinkCard: Story = { name: 'LinkCard · 长标题', args: { fixture: fromScenario('link-list-v3', 'LinkCard', 3) } };
