import { Image } from 'expo-image';
import { useIsFocused } from 'expo-router';
import { Monitor } from 'lucide-react-native';
import { useState, useSyncExternalStore } from 'react';
import { AppState, View } from 'react-native';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import type { BrowserTask, GatewayApi } from '@/gateway/api.ts';
import type { ChatSession } from '@/gateway/session.ts';
import { BrowserThumbnailResource } from '@/lib/browser-thumbnail-resource.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { cn } from '@/lib/utils.ts';
const subscribeAppState = (notify: () => void) => { const subscription = AppState.addEventListener('change', notify); return () => subscription.remove(); };
const appStateSnapshot = () => AppState.currentState;

/** Only visible, focused, foreground surfaces acquire an authenticated URI lease. */
export function BrowserThumbnail({ session, task, page, active, refresh = false, className }: {
  session: Pick<ChatSession, 'api' | 'connection' | 'queryIdentity'> | null;
  task: BrowserTask; page?: string; active: boolean; refresh?: boolean; className?: string;
}) {
  const focused = useIsFocused();
  const foreground = useSyncExternalStore(subscribeAppState, appStateSnapshot) === 'active';
  const target = page ?? task.current;
  const visible = active && focused && foreground && session?.connection === 'open' && task.state !== 'released' && task.pages.some(item => item.id === target);
  const source = visible && session && target ? session.api.browserThumbnailPath(task.id, target) : null;
  return <View testID={`browser-thumbnail-${task.id}`} className={cn('h-[150px] items-center justify-center overflow-hidden bg-muted', className)}>
    {source && session ? <ThumbnailImage key={`${session.queryIdentity}:${source}:${refresh}`} source={source} api={session.api} taskId={task.id} refresh={refresh}/> : <ThumbnailPlaceholder/>}
  </View>;
}
function ThumbnailPlaceholder({ failed = false }: { failed?: boolean }) {
  const { t } = useTranslation();
  return <View className="items-center gap-1.5"><Icon as={Monitor} className="size-6 text-muted-foreground"/><Text className="text-xs text-muted-foreground">{t(failed ? '画面暂不可用' : '等待浏览器画面')}</Text></View>;
}
function ThumbnailImage({ source, api, taskId, refresh }: { source: string; api: GatewayApi; taskId: string; refresh: boolean }) {
  const [resource] = useState(() => new BrowserThumbnailResource(api, source, refresh));
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  useMountEffect(() => resource.attach());
  if (snapshot.status === 'failed') return <ThumbnailPlaceholder failed/>;
  const uri = snapshot.uri;
  return <View testID={snapshot.status === 'displayed' ? `browser-thumbnail-displayed-${taskId}` : undefined} style={{ height: '100%', width: '100%' }}>
    {uri && <Image key={uri} source={{ uri }} cachePolicy="none" contentFit="cover" contentPosition="top" style={{ height: '100%', width: '100%' }} onDisplay={() => resource.displayed(uri)} onError={() => resource.failed(uri)}/>}
  </View>;
}
