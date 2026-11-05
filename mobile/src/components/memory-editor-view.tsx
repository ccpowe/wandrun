import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MemoryScope } from '@/gateway/api.ts';
import type { MemoryEditorSelection } from '@/lib/memory-editor.ts';
import { memoryIndexEntries } from '@/lib/memory-index.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';
import { AgentMemoryMarkdown } from './agent-memory-markdown.tsx';
import { LoadingState } from './loading-state.tsx';
import { ListGroup } from './list-group.tsx';
import { GroupRow } from './group-row.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Input } from './ui/input.tsx';
import { Text } from './ui/text.tsx';

export type MemoryEditorViewProps = {
  selection: MemoryEditorSelection; scope: MemoryScope; connectionBanner?: ReactNode; notice?: ReactNode; readError: string | null; online: boolean;
  onBack: () => void; onSave: () => void; onContent: (content: string) => void; onShowCurrent: () => void; onReload: () => void; onOpen: (slug?: string) => void;
};
export function MemoryEditorView({ selection: s, scope, connectionBanner, notice, readError, online, onBack, onSave, onContent, onShowCurrent, onReload, onOpen }: MemoryEditorViewProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const showReadError = useDelayedNotice(readError);
  const form = s.form;
  const index = s.remoteIndex ?? form?.base;
  const referenced = new Set(index && form ? memoryIndexEntries(form.content, index).map(entry => entry.slug) : []);
  const unreferenced = index ? Object.keys(index.details).filter(slug => !referenced.has(slug)) : [];
  return <View className="flex-1 bg-background">
    <ScreenBar title={scope === 'profile' ? t('编辑关于你') : t('编辑工作记忆')} left={<Button testID="memory-editor-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} disabled={!s.canBack} onPress={onBack}><Icon as={ChevronLeft} /></Button>}
      right={<Button testID="memory-editor-save" intent="quiet" disabled={!s.canSave} onPress={onSave}><Text>{s.busy && form && 'action' in form && form.action === 'save' ? t('保存中…') : t('保存')}</Text></Button>} />
    {connectionBanner}
    {s.error ? <View testID={form && 'action' in form && form.action === 'reload' ? 'memory-editor-reload-error' : 'memory-editor-error'}><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(s.error)} /></View>
      : readError && online && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('无法加载记忆，正在重试…')} description={form ? t('内容可能不是最新的') : undefined} /> : null}
    {notice}
    {!form && s.phase === 'loading' ? <LoadingState /> : null}
    {form ? <KeyboardAvoidingView behavior="padding" className="flex-1">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}>
        {s.conflict ? <View className="gap-3 rounded-lg bg-card p-4">
          <Text testID="memory-editor-conflict" variant="body">{s.remoteIndex?.updated_by === 'user' ? t('记忆已被用户更新。请先核对最新版本，再重新加载。') : t('记忆已在别处更新。请先核对最新版本，再重新加载。')}</Text>
          <View className="flex-row gap-2"><Button testID="memory-editor-view-current" intent="soft" disabled={!s.remoteIndex} onPress={onShowCurrent}><Text>{form.showCurrent ? t('收起最新版本') : t('查看最新版本')}</Text></Button>
            <Button testID="memory-editor-reload" intent="soft" disabled={!s.canReload} onPress={onReload}><Text>{s.busy && 'action' in form && form.action === 'reload' ? t('加载中…') : t('重新加载')}</Text></Button></View>
          <Text variant="caption" className="text-muted-foreground">{t('重新加载会保留草稿，之后保存将以草稿覆盖最新记忆，请先核对。')}</Text>
          {form.showCurrent && s.remoteIndex ? <ScrollView testID="memory-editor-current" className="max-h-36">
            {s.remoteIndex.content ? <AgentMemoryMarkdown content={s.remoteIndex.content} managedMemory={{ memory: s.remoteIndex, onOpen }} /> : <Text variant="caption" className="text-muted-foreground">{t('当前记忆为空')}</Text>}
          </ScrollView> : null}
        </View> : null}
        {form.result ? <Text testID="memory-editor-save-result" variant="caption" className="text-muted-foreground">{t(form.result)}</Text> : null}
        <Input testID="memory-editor-input" multiline textAlignVertical="top" className="min-h-80" accessibilityLabel={scope === 'profile' ? t('关于你 Markdown') : t('工作记忆 Markdown')} editable={s.canEdit} value={form.content} onChangeText={onContent} placeholder={scope === 'profile' ? t('稳定偏好或背景…') : t('对这个 Agent 的反馈…')} />
        <Text testID="memory-editor-count" variant="caption" className={s.count > s.limit ? 'text-right text-destructive' : 'text-right text-muted-foreground'}>{t('{count} / {limit} 字', { count: s.count, limit: s.limit })}</Text>
        {s.count > s.limit ? <Text testID="memory-editor-overlimit" variant="caption" className="text-destructive">{t('超过上限 {count} 字，请自行精简，草稿不会截断。', { count: s.count - s.limit })}</Text> : null}
        {unreferenced.length ? <View><Text variant="caption" className="mb-2 text-muted-foreground">{t('未被索引引用的详情')}</Text><ListGroup inset="content" className="-mx-4 mt-0">
          {unreferenced.map(slug => <GroupRow key={slug} testID={`memory-editor-detail-${slug}`} title={slug} affordance="navigate" disabled={!s.canOpen} onPress={() => onOpen(slug)} />)}
        </ListGroup></View> : null}
        <Button testID="memory-editor-new-detail" intent="soft" className="self-center" disabled={!s.canOpen} onPress={() => onOpen()}><Text>{t('新建详情')}</Text><Icon as={ChevronRight} className="size-4" /></Button>
      </ScrollView>
    </KeyboardAvoidingView> : null}
  </View>;
}
