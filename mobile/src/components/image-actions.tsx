import { useFocusEffect, useIsFocused } from 'expo-router';
import { Download, Share2 } from 'lucide-react-native';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Platform, View } from 'react-native';
import { mediaErrorMessage } from './rich-message/media.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Text } from './ui/text.tsx';
import { ActivityIndicator } from './ui/activity-indicator.tsx';
import { GatewayError, type GatewayApi } from '../gateway/api.ts';
import { newClientId } from '../gateway/session.ts';
import { deliverImage, type ImageAction, type ImageSource } from '../lib/image-delivery.ts';
import { DeliveryAccess } from '../lib/delivery-action.ts';
import { useTranslation } from '../lib/i18n.ts';
import { userErrorMessage } from '../lib/user-error.ts';

/** Blur removes pre-handoff controls. Native delivery retains its own URI lease once started. */
export function ImageActions(props: { api?: GatewayApi; source: ImageSource; light?: boolean }) {
  const focused = useIsFocused();
  return <ImageActionAccess key={JSON.stringify([props.api?.resourceIdentity, props.source, focused])} {...props} focused={focused} />;
}
function ImageActionAccess({ api, source, light = false, focused }: {
  api?: GatewayApi; source: ImageSource; light?: boolean; focused: boolean;
}) {
  const { t } = useTranslation();
  const [access] = useState(() => new DeliveryAccess());
  const state = useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
  useFocusEffect(useCallback(() => {
    access.open();
    return () => { access.send({ type: 'close' }); };
  }, [access]));
  const working = state.status === 'working' ? state.action : null;
  const disabled = !api || !focused || Platform.OS === 'web' || state.status !== 'idle' || api.signal.aborted;
  const open = async (action: ImageAction) => {
    if (!api || disabled) return;
    const operationId = newClientId();
    if (!access.send({ type: 'start', operationId, action })) return;
    const current = () => {
      const active = access.getSnapshot();
      return active.status === 'working' && active.operationId === operationId && !api.signal.aborted;
    };
    let saved = false;
    let error: string | null = null;
    try { saved = await deliverImage(api, source, action, current); }
    catch (cause) {
      error = source.location && cause instanceof GatewayError ? mediaErrorMessage(cause)
        : userErrorMessage(cause, action === 'download' ? '无法保存图片，请检查网络、存储空间和文件权限后重试' : '无法分享图片，请重新打开图片后重试');
    } finally {
      if (current()) access.send({ type: 'finished', operationId, saved, error });
    }
  };
  return <View className="items-end">
    <View className="flex-row items-center gap-1">
      <Button testID="media-download" intent="quiet" size="icon"
        aria-label={working === 'download' ? t('正在保存图片') : t('下载图片')} disabled={disabled} onPress={() => void open('download')}>
        {working === 'download' ? <ActivityIndicator size="small" /> : <Icon as={Download} className={`size-5 ${light ? 'text-immersive-foreground' : ''}`} />}
      </Button>
      <Button testID="media-share" intent="quiet" size="icon"
        aria-label={working === 'share' ? t('正在准备分享图片') : t('分享图片')} disabled={disabled} onPress={() => void open('share')}>
        {working === 'share' ? <ActivityIndicator size="small" /> : <Icon as={Share2} className={`size-5 ${light ? 'text-immersive-foreground' : ''}`} />}
      </Button>
    </View>
    {state.status === 'idle' && state.error && <Text testID="media-action-error" accessibilityLiveRegion="polite" variant="caption" className="max-w-56 text-right text-destructive">{t(state.error)}</Text>}
    {state.status === 'idle' && state.saved && <Text testID="media-saved" accessibilityLiveRegion="polite" variant="caption" className={light ? 'text-immersive-foreground' : 'text-muted-foreground'}>{t('已保存到所选位置')}</Text>}
  </View>;
}
