import type { ReactNode } from 'react';
import { ChevronLeft, CircleAlert } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type { MemoryEditorSelection } from '@/lib/memory-editor.ts';
import { memoryLength } from '@/lib/agent-memory.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';
import { AgentMemoryMarkdown } from './agent-memory-markdown.tsx';
import { LoadingState } from './loading-state.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Input } from './ui/input.tsx';
import { Text } from './ui/text.tsx';

export function MemoryDetailView({ selection: s, title, owner, modified, connectionBanner, notice, readError, online,
  onBack, onSave, onContent, onSlug, onEdit, onReload, onReviewDelete, onDeleteIndex, onCancelDelete, onDeleteDialog, onDelete, onOpen }: {
  selection: MemoryEditorSelection; title: string; owner: string; modified: string | null; connectionBanner?: ReactNode; notice?: ReactNode; readError: string | null; online: boolean;
  onBack: () => void; onSave: () => void; onContent: (content: string) => void; onSlug: (slug: string) => void; onEdit: () => void;
  onReload: () => void; onReviewDelete: () => void; onDeleteIndex: (content: string) => void; onCancelDelete: () => void;
  onDeleteDialog: (open: boolean) => void; onDelete: () => void; onOpen: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const showReadError = useDelayedNotice(readError);
  const form = s.form;
  const editing = form?.mode === 'editing';
  const reviewing = form?.mode === 'reviewing-delete';
  const creating = form?.kind === 'create';
  return <View className="flex-1 bg-background">
    <ScreenBar title={title} subtitle={owner} left={<Button testID="memory-detail-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} disabled={!s.canBack} onPress={onBack}><Icon as={ChevronLeft} /></Button>}
      right={editing ? <Button testID="memory-detail-save" intent="quiet" disabled={!s.canSave} onPress={onSave}><Text>{t('保存')}</Text></Button>
        : form && !reviewing && !s.missing ? <Button testID="memory-detail-edit" intent="quiet" disabled={!s.canStartEdit} onPress={onEdit}><Text variant="body">{t('编辑')}</Text></Button> : null} />
    {connectionBanner}
    {s.error ? <View testID="memory-detail-error"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(s.error)} /></View>
      : readError && online && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('无法加载记忆详情，正在重试…')} description={form ? t('内容可能不是最新的') : undefined} /> : null}
    {notice}
    {s.phase === 'missing' ? <Text variant="body" className="px-4 pt-8">{t('详情已删除')}</Text> : !form && s.phase === 'loading' ? <LoadingState /> : null}
    {form && s.phase !== 'missing' ? <KeyboardAvoidingView behavior="padding" className="flex-1"><ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4 pb-12 pt-4">
      {creating ? <Input testID="memory-detail-slug" accessibilityLabel={t('条目标识')} value={form.slug} editable={s.canEdit} onChangeText={onSlug} placeholder={t('条目标识（英文、数字、-、_）')} autoCapitalize="none" /> : null}
      {modified ? <Text testID="memory-detail-modified" variant="caption" className="text-muted-foreground">{modified}</Text> : null}
      {s.conflict ? <View className="gap-3 rounded-lg bg-card p-4"><Text testID="memory-detail-conflict" variant="body">{t('详情已在别处更新，草稿仍在。')}</Text>
        {s.remoteIndex ? creating ? <Text testID="memory-detail-current" variant="caption" className="text-muted-foreground">{s.remoteIndex.content}</Text>
          : s.remoteDetail === null ? <Text testID="memory-detail-current" variant="caption" className="text-muted-foreground">{t('最新详情已删除')}</Text>
            : s.remoteDetail ? <ScrollView testID="memory-detail-current" className="max-h-36"><Text variant="body">{s.remoteDetail.content}</Text></ScrollView>
              : <Text variant="caption" className="text-muted-foreground">{t('最新详情暂不可用，请重新加载')}</Text> : null}
        {reviewing && s.remoteIndex ? <View className="gap-2"><Text variant="body">{t('最新索引 Markdown')}</Text><Text testID="memory-detail-current-index" variant="caption" selectable>{s.remoteIndex.content}</Text></View> : null}
        <Button testID="memory-detail-reload" intent="soft" disabled={!s.canReload} onPress={onReload}><Text>{t('重新加载')}</Text></Button>
        <Text variant="caption" className="text-muted-foreground">{t('重新加载保留草稿；保存前请核对最新内容。')}</Text>
      </View> : null}
      {form.result ? <Text testID="memory-detail-save-result" variant="caption" className="text-muted-foreground">{t(form.result)}</Text> : null}
      {editing ? <>
        <Input testID="memory-detail-input" multiline textAlignVertical="top" accessibilityLabel={t('详情 Markdown')} className="min-h-80" value={form.content} editable={s.canEdit} onChangeText={onContent} />
        <Text testID="memory-detail-count" variant="caption" className={s.count > s.limit ? 'text-right text-destructive' : 'text-right text-muted-foreground'}>{t('{count} / {limit} 字节', { count: s.count, limit: s.limit })}</Text>
        {s.count > s.limit ? <Text testID="memory-detail-overlimit" variant="caption" className="text-destructive">{t('详情超过上限，请精简，草稿不会截断。')}</Text> : null}
      </> : <>
        <View testID="memory-detail-content"><AgentMemoryMarkdown content={s.detail?.content ?? form.content} managedMemory={{ memory: s.index ?? form.base, onOpen }} /></View>
        {!reviewing ? <Button testID="memory-detail-delete" intent="destructive" className="mt-6 self-center" disabled={!s.canDelete} onPress={onReviewDelete}><Text>{t('删除详情')}</Text></Button>
          : <View className="gap-3"><Text variant="body">{t('删除前核对索引')}</Text><Text variant="caption">{t('请从索引中移除该详情的所有链接，再删除详情。其他修改也会一同保存。')}</Text>
            <Text selectable variant="caption" className="text-muted-foreground">{form.detail?.path}</Text>
            <Text variant="body">{t('当前索引 Markdown')}</Text><Text testID="memory-detail-base-index" variant="caption" selectable className="text-muted-foreground">{form.base.content}</Text>
            <Input testID="memory-detail-delete-index" multiline textAlignVertical="top" accessibilityLabel={t('删除后的索引 Markdown')} className="min-h-64" value={form.deleteIndex} editable={s.phase === 'ready'} onChangeText={onDeleteIndex} />
            <Text testID="memory-detail-delete-count" variant="caption" className={memoryLength(form.deleteIndex) > form.base.limit ? 'text-right text-destructive' : 'text-right text-muted-foreground'}>{t('{count} / {limit} 字', { count: memoryLength(form.deleteIndex), limit: form.base.limit })}</Text>
            <View className="flex-row gap-3"><Button testID="memory-detail-delete-cancel" intent="soft" disabled={s.phase !== 'ready'} onPress={onCancelDelete}><Text>{t('取消')}</Text></Button>
              <Button testID="memory-detail-delete-confirm" intent="destructive" disabled={!s.canDelete || memoryLength(form.deleteIndex) > form.base.limit} onPress={() => onDeleteDialog(true)}><Text>{t('删除详情')}</Text></Button></View>
          </View>}
      </>}
    </ScrollView></KeyboardAvoidingView> : null}
    <AlertDialog open={!!form?.deleteOpen && s.phase === 'ready'} onOpenChange={onDeleteDialog}><AlertDialogContent testID="memory-detail-delete-dialog">
      <AlertDialogHeader><AlertDialogTitle>{t('删除详情？')}</AlertDialogTitle><AlertDialogDescription>{t('详情及索引中所做的修改会一同保存，无法恢复。')}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel><Text>{t('取消')}</Text></AlertDialogCancel><Button testID="memory-detail-delete-submit" intent="destructive" disabled={!s.canDelete} onPress={onDelete}><Text>{t('删除')}</Text></Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </View>;
}
