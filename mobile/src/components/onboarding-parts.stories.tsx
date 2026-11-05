import type { Meta, StoryObj } from '@storybook/react-native';
import { View } from 'react-native';
import { CommandText } from './command-text';
import { NumberedStep } from './numbered-step';
import { ThemedImage } from './themed-image';
import { FoundationFrame, type FoundationTheme } from '../dev/foundation-frame';

function Parts({ theme }: { theme: FoundationTheme }) {
  return <FoundationFrame theme={theme}><View className="gap-6 bg-background px-8 py-8">
    <View className="items-center"><ThemedImage light={require('../../assets/pairing-peek.png')} dark={require('../../assets/pairing-peek-dark.png')}
      accessible={false} resizeMode="contain" style={{ width: 180, height: 180 * 966 / 840 }} /></View>
    <NumberedStep index={1}>在服务器上运行 <CommandText>wandrun pair</CommandText></NumberedStep>
    <NumberedStep index={2}>用手机扫描屏幕上的二维码</NumberedStep>
  </View></FoundationFrame>;
}
const meta = { title: 'foundation/ThemedImage + NumberedStep + CommandText', component: Parts, parameters: { fullScreen: true } } satisfies Meta<typeof Parts>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: '浅色', args: { theme: 'light' } };
export const Dark: Story = { name: '深色', args: { theme: 'dark' } };
