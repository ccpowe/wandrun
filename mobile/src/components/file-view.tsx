import { AlertCircle, ArrowLeft, Download, Share2 } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FileDetail } from '../gateway/api.ts';
import type { DeliveryState } from '../lib/delivery-action.ts';
import { useTranslation } from '../lib/i18n.ts';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Text } from './ui/text.tsx';
import { ActivityIndicator } from './ui/activity-indicator.tsx';
import { LoadingState } from './loading-state.tsx';
import { StatusBanner } from './status-banner.tsx';

export function FileView({ file, loading, enabled, state, cacheError, feedback, origin, preview, onBack, onAction }: {
  file?: FileDetail; loading: boolean; enabled: boolean; state: DeliveryState; cacheError: string | null;
  feedback: ReactNode; origin: string; preview: ReactNode; onBack(): void; onAction(action: 'download' | 'share'): void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const working = state.status === 'working' ? state.action : null;
  return <View className="flex-1 bg-background" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
    <View className="flex-row items-center gap-3 px-4 py-2">
      <Button intent="quiet" size="icon" aria-label={t('返回')} onPress={onBack}><Icon as={ArrowLeft} className="size-5" /></Button>
      <Text numberOfLines={1} className="min-w-0 flex-1 text-lg font-medium">{file?.name ?? t('文件')}</Text>
      <View className="flex-row items-center gap-1">
        <Button testID="file-download" intent="quiet" size="icon" aria-label={working === 'download' ? t('正在保存文件') : t('下载文件')}
          disabled={!enabled || !file?.available || state.status !== 'idle'} onPress={() => onAction('download')}>
          {working === 'download' ? <ActivityIndicator size="small" /> : <Icon as={Download} className="size-5" />}
        </Button>
        <Button testID="file-share" intent="quiet" size="icon" aria-label={working === 'share' ? t('正在准备分享') : t('分享文件')}
          disabled={!enabled || !file?.available || state.status !== 'idle'} onPress={() => onAction('share')}>
          {working === 'share' ? <ActivityIndicator size="small" /> : <Icon as={Share2} className="size-5" />}
        </Button>
      </View>
    </View>
    {feedback || (file?.available === true && state.status === 'idle' && state.error
      ? <View testID="file-action-error"><StatusBanner icon={AlertCircle} accessibilityRole="alert" title={t(state.error)} /></View>
      : cacheError ? <View testID="file-cache-error"><StatusBanner icon={AlertCircle} accessibilityRole="alert" title={t(cacheError)} /></View> : null)}
    {state.status === 'idle' && state.saved && <Text testID="file-saved" accessibilityLiveRegion="polite" variant="caption" className="px-4 py-2 text-muted-foreground">{t('已保存到所选位置')}</Text>}
    {loading ? <LoadingState /> : file && <>
      <View className="gap-1 px-4 py-4">
        <Text variant="caption" className="text-muted-foreground">{origin}</Text>
        <Text variant="caption" className="text-muted-foreground">{file.name} · {Math.ceil(file.size / 1024)} KB</Text>
      </View>
      <ScrollView className="flex-1" contentContainerClassName="min-h-full px-4 py-6">{preview}</ScrollView>
    </>}
  </View>;
}
