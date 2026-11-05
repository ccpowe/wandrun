import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { AlertCircle, WifiOff } from 'lucide-react-native';
import { useCallback, useReducer, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Image, Platform, View } from 'react-native';
import { FileView } from '@/components/file-view.tsx';
import { FileTypeIcon } from '@/components/file-type-icon.tsx';
import { StatusBanner } from '@/components/status-banner.tsx';
import { ActivityIndicator } from '@/components/ui/activity-indicator.tsx';
import { Text } from '@/components/ui/text.tsx';
import { AgentMemoryMarkdown } from '@/components/agent-memory-markdown.tsx';
import type { FileDetail } from '@/gateway/api.ts';
import { newClientId, type ChatSession } from '@/gateway/session.ts';
import { DeliveryAccess, leaseReducer, type LeaseState } from '@/lib/delivery-action.ts';
import { previewKind, TEXT_PREVIEW_BYTES, type CachedDownload } from '@/lib/file-delivery.ts';
import { selectFileRead } from '@/lib/file-viewer.ts';
import { fileDetailOptions, readFileForDelivery } from '@/lib/gateway-queries.ts';
import { nativeDeliveryCache } from '@/lib/native-delivery-cache.ts';
import { saveNativeFile } from '@/lib/native-file-save.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useConnectionLabel } from '@/lib/connection-banner.tsx';
import { useSession } from '@/lib/session-context.tsx';
import { useGatewayQuery } from '@/lib/use-gateway-query.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { UserFacingError, userErrorMessage } from '@/lib/user-error.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';

export default function FileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  return <><Stack.Screen options={{ headerShown: false }} />{session && id ? <FileDetailScreen session={session} id={id} /> : null}</>;
}
export function FileDetailScreen({ session, id }: { session: ChatSession; id: string }) {
  return <FileContainer key={`${session.queryIdentity}:${id}`} session={session} id={id} />;
}
function FileContainer({ session, id }: { session: ChatSession; id: string }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const { t } = useTranslation();
  const focused = useIsFocused();
  const read = useGatewayQuery(fileDetailOptions(session, id), Platform.OS !== 'web');
  const label = useConnectionLabel(session);
  const selection = selectFileRead(read.data, read.error, read.fetchStatus === 'paused');
  const showReadError = useDelayedNotice(selection.retrying ? id : null);
  const feedback = label ? <StatusBanner icon={WifiOff} title={label} description={t('内容可能不是最新的')} />
    : selection.feedback && (!selection.retrying || showReadError) ? <StatusBanner icon={AlertCircle} title={t(selection.feedback)} description={selection.stale ? t('内容可能不是最新的') : undefined} /> : null;
  if (Platform.OS === 'web') return <View className="flex-1 items-center justify-center bg-background p-8"><Text className="text-center text-muted-foreground">{t('文件预览与系统分享仅支持移动设备')}</Text></View>;
  // A byte/native refusal contradicts availability: its check must supersede older in-flight reads.
  return <FileAccess key={`${focused}`} session={session} id={id} file={selection.file} loading={selection.loading} focused={focused} feedback={feedback} refresh={read.retry} />;
}
function FileAccess({ session, id, file, loading, focused, feedback, refresh }: {
  session: ChatSession; id: string; file?: FileDetail; loading: boolean; focused: boolean; feedback: ReactNode; refresh(): Promise<void>;
}) {
  const { t, locale } = useTranslation();
  const [access] = useState(() => new DeliveryAccess());
  const state = useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const computerId = session.api.config.computerId!;
  useFocusEffect(useCallback(() => {
    access.open();
    try { nativeDeliveryCache(computerId).prune(); setCacheError(null); }
    catch (cause) { setCacheError(userErrorMessage(cause, '无法清理文件缓存，请重新打开文件后重试')); }
    return () => { access.send({ type: 'close' }); };
  }, [access, computerId]));
  const openNative = async (action: 'download' | 'share') => {
    if (!focused || state.status !== 'idle' || !file?.available || session.api.signal.aborted) return;
    const operationId = newClientId();
    if (!access.send({ type: 'start', operationId, action })) return;
    const current = () => {
      const active = access.getSnapshot();
      return active.status === 'working' && active.operationId === operationId && !session.api.signal.aborted;
    };
    let cached: CachedDownload | null = null;
    let saved = false;
    let error: string | null = null;
    try {
      const detail = await readFileForDelivery(session.api, id);
      if (!current() || !detail.available) return;
      if (action === 'download') {
        saved = await saveNativeFile(session.api.fileContentUrl(id, true), session.api.headers(), detail, current, session.api.signal);
      } else {
        if (!await Sharing.isAvailableAsync()) throw new UserFacingError('此设备不支持系统文件分享');
        if (!current()) return;
        cached = await nativeDeliveryCache(computerId).download(session.api.fileContentUrl(id, true), detail, session.api.headers(), session.api.signal);
        if (!current()) return;
        // Native now owns its own read lease; leaving must not interrupt this handoff.
        await cached.share(uri => Sharing.shareAsync(uri, { mimeType: detail.media_type, dialogTitle: detail.name }));
      }
    } catch (cause) {
      error = userErrorMessage(cause, action === 'download' ? '无法保存文件，请检查网络、存储空间和文件权限后重试' : '无法分享文件，请重新打开文件后重试');
      if (current()) { void refresh(); void session.api.checkUnauthorized(); }
    } finally {
      try { cached?.release(); }
      catch (cause) { error ??= userErrorMessage(cause, '无法清理文件缓存，请重新打开文件后重试'); }
      if (current()) access.send({ type: 'finished', operationId, saved, error });
    }
  };
  const agentName = session.agents.agents.find(agent => agent.id === file?.agent_id)?.name;
  const sourceId = file?.conversation_id && !session.isDeleted(file.conversation_id) ? file.conversation_id : null;
  const origin = file ? `${file.source === 'user_upload' ? t('我上传的文件') : agentName ?? t('Agent 暂不可用')} · ${sourceId ? session.conversations.get(sourceId)?.title ?? t('来源对话') : file.conversation_id ? t('来源对话已删除') : t('无来源对话')} · ${new Date(file.created_at * 1000).toLocaleString(locale)}` : '';
  return <FileView file={file} loading={loading} enabled={focused && session.connection === 'open'} state={state} cacheError={cacheError}
    feedback={feedback} origin={origin} onBack={() => router.back()} onAction={action => void openNative(action)}
    preview={file ? <FilePreview key={JSON.stringify([file.id, file.size, file.media_type, file.available])} session={session} file={file} focused={focused} refresh={refresh} /> : null} />;
}
function FilePreview({ session, file, focused, refresh }: { session: ChatSession; file: FileDetail; focused: boolean; refresh(): Promise<void> }) {
  const { t } = useTranslation();
  const kind = previewKind(file);
  if (!file.available) return <View testID="file-unavailable" className="items-center gap-3 rounded-lg bg-muted p-8"><FileTypeIcon mediaType={file.media_type} name={file.name} className="size-8 text-muted-foreground" /><Text className="text-center">{t(file.error_message || '文件暂不可用')}</Text></View>;
  if (kind === 'other') return <View className="items-center gap-3 rounded-lg bg-card p-8"><FileTypeIcon mediaType={file.media_type} name={file.name} className="size-9 text-muted-foreground" /><Text>{t('此格式不支持应用内预览')}</Text><Text variant="caption" className="text-center text-muted-foreground">{t('可下载文件，或分享给其他应用打开。')}</Text></View>;
  if (kind === 'text' && file.size === 0) return <View testID="file-text-preview"><Text /></View>;
  return focused ? <FilePreviewResource session={session} file={file} kind={kind} refresh={refresh} /> : null;
}
function FilePreviewResource({ session, file, kind, refresh }: { session: ChatSession; file: FileDetail; kind: 'text' | 'image'; refresh(): Promise<void> }) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(leaseReducer<string>, { status: 'loading' } as LeaseState<string>);
  useMountEffect(() => {
    let active = true;
    const transfer = new AbortController();
    const closed = () => transfer.abort();
    session.api.signal.addEventListener('abort', closed, { once: true });
    if (session.api.signal.aborted) closed();
    let cached: CachedDownload | null = null;
    void (async () => {
      try {
        cached = await nativeDeliveryCache(session.api.config.computerId!).download(session.api.fileContentUrl(file.id), file,
          kind === 'text' ? session.api.headers({ Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` }) : session.api.headers(), transfer.signal);
        if (!active || transfer.signal.aborted) return;
        const value = kind === 'text' ? await cached.file.text() : cached.file.uri;
        if (active && !transfer.signal.aborted) dispatch({ type: 'ready', value });
      } catch (cause) {
        if (active && !transfer.signal.aborted) {
          dispatch({ type: 'failed', error: userErrorMessage(cause, '无法预览文件，请重试或下载后打开') });
          void refresh(); void session.api.checkUnauthorized(transfer.signal);
        }
      } finally { if (!active || transfer.signal.aborted || kind === 'text') cached?.release(); }
    })();
    return () => { active = false; transfer.abort(); session.api.signal.removeEventListener('abort', closed); cached?.release(); };
  });
  if (state.status === 'loading') return <ActivityIndicator />;
  if (state.status === 'failed') return <Text className="text-center text-destructive">{t(state.error)}</Text>;
  if (kind === 'image') return <Image testID="file-image-preview" source={{ uri: state.value }} resizeMode="contain" className="w-full" style={{ height: 440 }} />;
  return <View testID="file-text-preview">{file.media_type.split(';', 1)[0].toLowerCase() === 'text/markdown' ? <AgentMemoryMarkdown content={state.value} /> : <Text selectable className="text-base leading-7">{state.value}</Text>}
    {file.size > TEXT_PREVIEW_BYTES && <Text variant="caption" className="mt-4 text-muted-foreground">{t('仅预览前 1 MB，下载查看完整内容。')}</Text>}
  </View>;
}
