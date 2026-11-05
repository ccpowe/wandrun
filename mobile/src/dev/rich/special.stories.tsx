import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, fromScenario, node } from './rich-fixtures';
import { RichStory } from './rich-story';

const meta = {
  title: 'rich/06 Mermaid、公式与文件树', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
  args: { fixture: fromScenario('mermaid', 'Mermaid') },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mermaid: Story = { name: 'Mermaid · 本地流程图' };
export const InvalidMermaid: Story = { name: 'Mermaid · 语法错误与源码', args: { fixture: fromScenario('mermaid-invalid', 'Mermaid') } };
export const TallMermaid: Story = { name: 'Mermaid · 长图', args: { fixture: fromScenario('mermaid-tall', 'Mermaid') } };
export const Math: Story = { name: 'Math · 块公式', args: { fixture: fromScenario('math', 'Math') } };
export const InlineMath: Story = { name: 'Math · 行内公式与正文', args: { fixture: fromScenario('math', 'Text') } };
export const InvalidMath: Story = { name: 'Math · 无效公式', args: { fixture: fixture(node('Math', { tex: '\\frac{1}{', display: true })) } };
export const FileTree: Story = { name: 'FileTree · 自动补齐父目录', args: { fixture: fromScenario('file-tree-v3', 'FileTree') } };
export const LargeFileTree: Story = { name: 'FileTree · 长路径与折叠目录', args: { fixture: fromScenario('file-tree-large', 'FileTree') } };
