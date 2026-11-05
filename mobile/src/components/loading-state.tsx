import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n.ts';
import { deferLoadingIndicator } from '@/lib/load-state.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { ActivityIndicator } from '@/components/ui/activity-indicator.tsx';

/** Mount only while the first load is pending; unmount cancels the feedback delay. */
export function LoadingState({ delayMs }: { delayMs?: number }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return <View className="flex-1 items-center justify-center">
    <LoadingDelay key={delayMs} delayMs={delayMs} onVisible={() => setVisible(true)} />
    {visible ? <ActivityIndicator accessible accessibilityRole="progressbar" accessibilityLabel={t('加载中…')} /> : null}
  </View>;
}

function LoadingDelay({ delayMs, onVisible }: { delayMs?: number; onVisible: () => void }) {
  useMountEffect(() => deferLoadingIndicator(onVisible, delayMs));
  return null;
}
