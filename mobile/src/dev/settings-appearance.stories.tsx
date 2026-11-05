import type { Meta, StoryObj } from '@storybook/react-native';
import { useMemo } from 'react';
import { Uniwind } from 'uniwind';
import AppearanceSettings from '../app/settings-appearance';
import { Text } from '../components/ui/text';
import { AppearanceStore } from '../lib/appearance';
import { appearance, AppearanceProvider, AppearanceStoreProvider } from '../lib/appearance-context';
import { applyLanguage } from '../lib/locale-store';
import { SceneProviders } from './scene-providers';
import { useMountEffect } from '../lib/use-mount-effect';

const routes = { '/': () => <Text>设置</Text> };
function AppearanceScene({ failWrite = false, delayWrite = false, restore = 'ready' }: {
  failWrite?: boolean; delayWrite?: boolean; restore?: 'ready' | 'loading' | 'retry' | 'invalid';
}) {
  return <AppearanceContent key={`${failWrite}:${delayWrite}:${restore}`} failWrite={failWrite} delayWrite={delayWrite} restore={restore} />;
}
function AppearanceContent({ failWrite, delayWrite, restore }: { failWrite: boolean; delayWrite: boolean; restore: 'ready' | 'loading' | 'retry' | 'invalid' }) {
  const store = useMemo(() => {
    let reads = 0;
    return new AppearanceStore({
    read: async () => {
      if (restore === 'loading') return Promise.withResolvers<string | null>().promise;
      if (restore === 'retry' && reads++ === 0) throw new Error('simulated device read failure');
      return restore === 'invalid' ? '{"language":"invalid"}' : JSON.stringify({ language: 'zh', theme: 'system' });
    },
    write: async () => {
      if (delayWrite) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1500);
        await promise;
      }
      if (failWrite) throw new Error('simulated device storage failure');
    },
  }, preferences => { Uniwind.setTheme(preferences.theme); applyLanguage(preferences.language); });
  }, [failWrite, delayWrite, restore]);
  useMountEffect(() => () => {
    Uniwind.setTheme(appearance.snapshot().theme);
    applyLanguage(appearance.snapshot().language);
  });
  return <AppearanceStoreProvider store={store}><AppearanceProvider>
    <SceneProviders path="/settings-appearance" routes={routes}><AppearanceSettings /></SceneProviders>
  </AppearanceProvider></AppearanceStoreProvider>;
}
const meta = { title: 'settings-appearance', component: AppearanceScene, parameters: { fullScreen: true } } satisfies Meta<typeof AppearanceScene>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A1: Story = { name: 'A1 本地语言与颜色模式', args: {} };
export const A4: Story = { name: 'A4 写入失败保留旧值（选择任一新值）', args: { failWrite: true } };
export const A2: Story = { name: 'A2 保存中保留旧值，返回可用', args: { delayWrite: true } };
export const B1: Story = { name: 'B1 启动读取中不挂载页面', args: { restore: 'loading' } };
export const B2Retry: Story = { name: 'B2 暂时读取失败后自动恢复', args: { restore: 'retry' } };
export const B2Invalid: Story = { name: 'B2 保存内容损坏，不清空不无限重试', args: { restore: 'invalid' } };
