import { useState } from 'react';
import { Image, View } from 'react-native';
import { useCSSVariable } from 'uniwind';
import { Text } from '@/components/ui/text';

/** Source-keyed failure is local image UI, not connector health or persisted business state. */
export function ConnectorIcon({ name, uri, appId, large = false }: {
  name: string; uri?: string | null; appId?: string | null; large?: boolean;
}) {
  return <ConnectorIconSource key={`${uri ?? ''}:${appId ?? ''}`} name={name} uri={uri} appId={appId} large={large} />;
}
function ConnectorIconSource({ name, uri, appId, large }: { name: string; uri?: string | null; appId?: string | null; large: boolean }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const foreground = String(useCSSVariable('--color-foreground'));
  // Notion / GitHub: Simple Icons 16.0.0, CC0-1.0. AMap: Arcticons `autonavi` (the AMap app's icon,
  // CC BY-SA 4.0, stroke widened to 2.5). Bundled rasterizations use theme foreground in both themes.
  const brand = appId === 'notion' ? require('../../assets/apps/notion.png') : appId === 'github' ? require('../../assets/apps/github.png')
    : appId === 'amap' ? require('../../assets/apps/amap.png') : undefined;
  const remote = !brand && uri && /^https?:\/\//i.test(uri) ? uri : undefined;
  const source = brand ?? (remote && status !== 'failed' ? { uri: remote } : undefined);
  const showFallback = !source || !brand && status !== 'loaded';
  return <View className={`${large ? 'size-16' : 'size-8'} items-center justify-center rounded-full bg-muted`}>
    {showFallback ? <Text variant="body" className={large ? 'text-title' : undefined}>{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'}</Text> : null}
    {source ? <Image testID="connector-icon-image" source={source} resizeMode="contain" accessible={false} fadeDuration={0}
      onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')}
      className={`${large ? 'size-12' : 'size-6'}${brand ? '' : ' absolute'}`}
      style={!brand && status !== 'loaded' ? { opacity: 0 } : undefined} tintColor={brand ? foreground : undefined} /> : null}
  </View>;
}
