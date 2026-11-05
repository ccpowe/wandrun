import type { Meta, StoryObj } from '@storybook/react-native';
import { fromScenario } from './rich-fixtures';
import { RichStory } from './rich-story';

const choice = fromScenario('travel', 'ChoiceGroup');
const select = fromScenario('components', 'Select');
const segmented = fromScenario('weekly', 'Segmented');
const multiSelect = fromScenario('weekly', 'MultiSelect');
const switchField = fromScenario('weekly', 'Switch');
const slider = fromScenario('weekly', 'Slider');
const textInput = fromScenario('travel', 'TextInput');
const dateInput = fromScenario('appointment', 'DateInput');
const form = fromScenario('travel', 'Card');
const meta = {
  title: 'rich/03 输入与提交', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
  args: { fixture: choice },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChoiceGroup: Story = { name: 'ChoiceGroup · 选择方案' };
export const ChoiceGroupSubmitted: Story = { name: 'ChoiceGroup · 已提交只读', args: { mode: 'submitted' } };
export const ChoiceGroupDisabled: Story = { name: 'ChoiceGroup · 提交中禁用', args: { mode: 'submitting' } };
export const DisabledChoice: Story = { name: 'ChoiceGroup · 包含不可选项', args: { fixture: fromScenario('appointment', 'ChoiceGroup') } };
export const Select: Story = { name: 'Select · 未选择与不可选项', args: { fixture: select } };
export const SelectSubmitted: Story = { name: 'Select · 已提交只读', args: { fixture: { ...select, spec: { ...select.spec, state: { release: 'canary' } } }, mode: 'submitted' } };
export const SelectDisabled: Story = { name: 'Select · 提交中禁用', args: { fixture: select, mode: 'submitting' } };
export const Segmented: Story = { name: 'Segmented · 篇幅', args: { fixture: segmented } };
export const SegmentedSubmitted: Story = { name: 'Segmented · 已提交只读', args: { fixture: segmented, mode: 'submitted' } };
export const SegmentedDisabled: Story = { name: 'Segmented · 提交中禁用', args: { fixture: segmented, mode: 'submitting' } };
export const MultiSelect: Story = { name: 'MultiSelect · 多选标签', args: { fixture: multiSelect } };
export const MultiSelectChecklist: Story = { name: 'MultiSelect · 文件清单', args: { fixture: fromScenario('files', 'MultiSelect') } };
export const MultiSelectSubmitted: Story = { name: 'MultiSelect · 已提交只读', args: { fixture: multiSelect, mode: 'submitted' } };
export const MultiSelectDisabled: Story = { name: 'MultiSelect · 提交中禁用', args: { fixture: multiSelect, mode: 'submitting' } };
export const Switch: Story = { name: 'Switch · 配图开关', args: { fixture: switchField } };
export const SwitchOff: Story = { name: 'Switch · 关闭', args: { fixture: { ...switchField, spec: { ...switchField.spec, state: { screenshots: false } } } } };
export const SwitchSubmitted: Story = { name: 'Switch · 已提交只读', args: { fixture: switchField, mode: 'submitted' } };
export const SwitchDisabled: Story = { name: 'Switch · 提交中禁用', args: { fixture: switchField, mode: 'submitting' } };
export const Slider: Story = { name: 'Slider · 小数步长', args: { fixture: slider } };
export const SliderSubmitted: Story = { name: 'Slider · 已提交只读', args: { fixture: slider, mode: 'submitted' } };
export const SliderDisabled: Story = { name: 'Slider · 提交中禁用', args: { fixture: slider, mode: 'submitting' } };
export const TextInput: Story = { name: 'TextInput · 多行备注', args: { fixture: textInput } };
export const SingleLineTextInput: Story = { name: 'TextInput · 单行空值', args: { fixture: fromScenario('weekly', 'TextInput') } };
export const TextInputSubmitted: Story = { name: 'TextInput · 已提交只读', args: { fixture: textInput, mode: 'submitted' } };
export const TextInputDisabled: Story = { name: 'TextInput · 提交中禁用', args: { fixture: textInput, mode: 'submitting' } };
export const DateInput: Story = { name: 'DateInput · 已选日期', args: { fixture: dateInput } };
export const EmptyDateInput: Story = { name: 'DateInput · 未选日期', args: { fixture: { ...dateInput, spec: { ...dateInput.spec, state: { date: '' } } } } };
export const DateInputSubmitted: Story = { name: 'DateInput · 已提交只读', args: { fixture: dateInput, mode: 'submitted' } };
export const DateInputDisabled: Story = { name: 'DateInput · 提交中禁用', args: { fixture: dateInput, mode: 'submitting' } };
export const Submit: Story = { name: 'Submit · 本地提交成功', args: { fixture: form } };
export const SubmitSubmitted: Story = { name: 'Submit · 已提交回执', args: { fixture: form, mode: 'submitted' } };
export const SubmitDisabled: Story = { name: 'Submit · 提交中', args: { fixture: form, mode: 'submitting' } };
export const SubmitError: Story = { name: 'Submit · 点击后显示本地失败', args: { fixture: form, mode: 'error' } };
