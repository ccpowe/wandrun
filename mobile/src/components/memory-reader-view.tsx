import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import type { AgentMemory, MemoryScope } from '@/gateway/api.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';
import { AgentMemoryMarkdown } from './agent-memory-markdown.tsx';
import { LoadingState } from './loading-state.tsx';
import { StatusBanner } from './status-banner.tsx';
import { Button } from './ui/button.tsx';
import { Text } from './ui/text.tsx';

export type MemoryReaderPage = (content: ReactNode, edit: ReactNode) => ReactNode;

/** Shared full-index reading surface. Resource ownership and navigation stay in the container. */
export function MemoryReaderView({ memory, scope, modified, error, online, connectionBanner, onEdit, onOpen, renderPage }: {
  memory: AgentMemory | null; scope: MemoryScope; modified: string | null; error: boolean; online: boolean;
  connectionBanner?: ReactNode; onEdit: () => void; onOpen: (slug: string) => void; renderPage?: MemoryReaderPage;
}) {
  const { t } = useTranslation();
  const showReadError = useDelayedNotice(error ? scope : null);
  const prefix = scope === 'profile' ? 'profile-shared-memory' : 'profile-memory';
  const edit = <Button testID={`${prefix}-edit`} intent="quiet" disabled={!memory} onPress={onEdit}><Text variant="body">{t('编辑')}</Text></Button>;
  const inlineEdit = scope === 'work' || !renderPage ? edit : null;
  const content = <View className="flex-1">{connectionBanner}
    {error && online && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('无法加载记忆，正在重试…')} description={memory ? t('内容可能不是最新的') : undefined} /> : null}
    {!memory && !error ? <LoadingState /> : null}
    <ScrollView contentContainerClassName="px-4 pb-12">
      {memory ? memory.content ? <>
        <View className="mt-4 flex-row items-center gap-2"><Text testID={`${prefix}-modified`} variant="caption" className="flex-1 text-muted-foreground">{modified}</Text>{inlineEdit}</View>
        <View testID={`${prefix}-content`}><AgentMemoryMarkdown content={memory.content} memoryIndex managedMemory={{ memory, onOpen }} /></View>
      </> : <View testID={scope === 'work' ? 'profile-empty-memory' : `${prefix}-empty`} className="items-center gap-4 pt-12"><Text variant="body" className="text-muted-foreground">{scope === 'profile' ? t('还没有内容') : t('还没有工作记忆')}</Text>{inlineEdit}</View> : null}
    </ScrollView>
  </View>;
  return renderPage ? renderPage(content, edit) : content;
}
