import { View } from 'react-native';
import { Button } from '../components/ui/button.tsx';
import { Text } from '../components/ui/text.tsx';
import { useTranslation } from '../lib/i18n.ts';
import { useDelayedNotice } from '../lib/use-delayed-notice.ts';

import type { VideoPhase, VideoFailureReason } from '../lib/browser-video.ts';

const failureMessages: Record<VideoFailureReason, string> = {
  'publisher-not-installed': '推流组件未安装，请让 Agent 重新运行浏览器启动脚本',
  'publisher-start-timeout': '视频启动超时',
  'publisher-exited': '视频推流已停止',
  'cdp-unreachable': '浏览器连接不可用，请确认浏览器已启动后重试',
  'page-publish-timeout': '页面视频发布超时',
  'sfu-unreachable': '无法连接视频服务',
  'join-timeout': '无法连接视频服务',
  'token-failed': '无法获取视频授权',
  'watch-limit': '本环境同时观看的视频页面已达上限',
  'page-unavailable': '找不到这个页面的画面',
  'first-frame-timeout': '5 秒内没有收到视频画面',
};


/** D2 / D3 / D4 / D6. A failure hides the old surface; transitions never cover it. */
export function BrowserVideoOverlay({ phase, reason, hasPicture, onRetry }: {
  phase: VideoPhase; reason: VideoFailureReason | null; hasPicture: boolean;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const showTransition = useDelayedNotice(hasPicture && phase !== 'playing' && phase !== 'failed' ? phase === 'reconnecting' ? 'reconnecting' : 'switching' : null);
  if (phase === 'failed') return <View className="absolute inset-0 items-center justify-center gap-3 bg-immersive-panel px-8">
    <Text className="text-lg font-medium text-immersive-foreground">{t('无法显示视频')}</Text>
    <Text variant="caption" className="text-center text-immersive-muted-foreground">{t(failureMessages[reason ?? 'sfu-unreachable'])}</Text>
    <Button intent="soft" accessibilityLabel={t('重试视频')} onPress={onRetry}><Text>{t('重试视频')}</Text></Button>
  </View>;
  if (phase === 'playing') return null;
  if (!hasPicture) return <View pointerEvents="none" className="absolute inset-0 items-center justify-center"><Text variant="caption" className="text-immersive-muted-foreground">{t('正在连接视频…')}</Text></View>;
  if (!showTransition) return null;
  return <View pointerEvents="none" className="absolute inset-x-2 top-2 items-center"><Text variant="caption" className="rounded-full bg-immersive-scrim px-3 py-2 text-immersive-foreground">{t(phase === 'reconnecting' ? '视频重连中…' : '画面切换中…')}</Text></View>;
}
