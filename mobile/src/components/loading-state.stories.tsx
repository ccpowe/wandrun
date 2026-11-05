import type { Meta, StoryObj } from '@storybook/react-native';
import { LoadingState } from './loading-state';
const meta = { title: 'LoadingState', component: LoadingState } satisfies Meta<typeof LoadingState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const pending: Story = {};
