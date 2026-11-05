import type { ReactNode } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { ChevronLeft, CircleAlert, Pencil, Plus } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from './empty-state.tsx';
import { LoadingState } from './loading-state.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { SwipeRow } from './swipe-row.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { SurfacePressable } from './ui/surface-pressable.tsx';
import { Text } from './ui/text.tsx';
import { WandrunAvatar } from './wandrun-avatar.tsx';
import type { AgentSummary } from '../gateway/api.ts';
import type { AgentListSelection } from '../lib/agent-list-state.ts';
import { useTranslation } from '../lib/i18n.ts';
import { cn } from '../lib/utils.ts';
import { useDelayedNotice } from '../lib/use-delayed-notice.ts';

type RowData = Pick<AgentSummary, 'id' | 'name' | 'avatar' | 'description'>;
type RowProps = RowData & {
  disabled: boolean; editingDisabled: boolean; first: boolean; last: boolean;
  onOpen(id: string): void; onEdit(id: string): void;
  onSwipeChange(open: boolean, close: () => void): void;
};
const AgentRowContent = memo(function AgentRowContent({ name, avatar, description }: Omit<RowData, 'id'>) {
  return <View className="min-h-[60px] flex-row items-center gap-3 px-4 py-2">
    <WandrunAvatar index={avatar} alt={name} size={40} />
    <View className="min-w-0 flex-1 gap-0.5"><Text variant="body" numberOfLines={1}>{name}</Text><Text variant="caption" numberOfLines={1} className="text-muted-foreground">{description || ' '}</Text></View>
  </View>;
});
const AgentRow = memo(function AgentRow({ id, name, avatar, description, disabled, editingDisabled, first, last, onOpen, onEdit, onSwipeChange }: RowProps) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(id), [id, onOpen]);
  const edit = useCallback(() => onEdit(id), [id, onEdit]);
  const editLabel = t('编辑 {name}', { name });
  const action = useMemo(() => ({ label: editLabel, icon: Pencil, disabled: editingDisabled, onPress: edit }), [editLabel, editingDisabled, edit]);
  const surface = cn('bg-card', first && 'rounded-t-lg', last && 'rounded-b-lg');
  return <View testID={`agent-row-container-${id}`} className={surface}>
    <SwipeRow enabled={!editingDisabled} contentClassName={surface} actionClassName={cn(first && 'rounded-tr-lg', last && 'rounded-br-lg')} action={action} onOpenChange={onSwipeChange}>
      <SurfacePressable testID={`agent-row-${id}`} className={surface} accessibilityRole="button"
        accessibilityLabel={t('查看 {name} 的资料', { name })} accessibilityState={{ disabled }} disabled={disabled} onPress={open}>
        <AgentRowContent name={name} avatar={avatar} description={description} />
      </SurfacePressable>
    </SwipeRow>
    {!first ? <View pointerEvents="none" className="absolute left-12 right-4 top-0 h-px bg-border/50" /> : null}
  </View>;
});

export type AgentListViewProps = {
  selection: AgentListSelection; showFeedback: boolean; connectionBanner: ReactNode;
  onBack(): void; onAdd(): void; onOpen(id: string): void; onEdit(id: string): void;
  onSwipeChange(open: boolean, close: () => void): void;
};
export function AgentListView(props: AgentListViewProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { selection } = props;
  const { rows, rowDisabled } = selection;
  const showReadError = useDelayedNotice(selection.readError ? 'agents' : null);
  return <View className="flex-1 bg-background" testID="agent-list-screen">
    <ScreenBar title="Agent" left={<Button testID="agents-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={props.onBack}><Icon as={ChevronLeft} size={22} /></Button>}
      right={<Button testID="agents-add" intent="quiet" size="icon" accessibilityLabel={t('新建 Agent')} disabled={selection.blocked} onPress={props.onAdd}><Icon as={Plus} size={22} /></Button>} />
    {props.connectionBanner}
    {props.showFeedback && selection.readError && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('无法加载 Agent，正在重试…')} description={selection.loaded ? t('内容可能不是最新的') : undefined} /> : null}
    {selection.empty ? <EmptyState title={t('还没有 Agent')}><Button intent="soft" testID="agents-create-empty" disabled={selection.blocked} onPress={props.onAdd}><Text>{t('新建 Agent')}</Text></Button></EmptyState>
      : <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}>
        {selection.loading ? <View className="mt-8"><LoadingState /></View> : null}
        {rows.length ? <View className="mx-4 mt-2 rounded-lg">
          {rows.map((agent, index) => <AgentRow key={agent.id} id={agent.id} name={agent.name} avatar={agent.avatar} description={agent.description}
            disabled={rowDisabled} editingDisabled={selection.blocked} first={index === 0} last={index === rows.length - 1}
            onOpen={props.onOpen} onEdit={props.onEdit} onSwipeChange={props.onSwipeChange} />)}
        </View> : null}
      </ScrollView>}
  </View>;
}
