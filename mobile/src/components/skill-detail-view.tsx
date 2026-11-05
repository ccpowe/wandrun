import { ChevronLeft, ChevronRight, CircleAlert, UserRound } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentMemoryMarkdown } from './agent-memory-markdown.tsx';
import { GroupRow } from './group-row.tsx';
import { ListGroup } from './list-group.tsx';
import { LoadingState } from './loading-state.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import { Icon } from './ui/icon.tsx';
import { SurfacePressable } from './ui/surface-pressable.tsx';
import { Text } from './ui/text.tsx';
import { WandrunAvatar } from './wandrun-avatar.tsx';
import type { BuiltinSkillDetail, SkillDetail } from '../gateway/api.ts';
import { useTranslation } from '../lib/i18n.ts';
import type { SkillDeletionState } from '../lib/skill-deletion.ts';
import type { SkillDetailSelection, SkillUser } from '../lib/skill-detail.ts';
import { skillMarkdown } from '../lib/skills.ts';

type Props = { name: string; detail?: SkillDetail; users: SkillUser[]; selection: SkillDetailSelection; action: SkillDeletionState;
  banner: ReactNode; loading: boolean; refreshing: boolean; online: boolean;
  onBack(): void; onRefresh(): void; onUser(user: SkillUser): void; onUsers(open: boolean): void;
  onDeleteCheck(): void; onDelete(): void; onDeleteCancel(): void };
export function SkillDetailView({ name, detail, users, selection, action, banner, loading, refreshing, online,
  onBack, onRefresh, onUser, onUsers, onDeleteCheck, onDelete, onDeleteCancel }: Props) {
  const { t, locale } = useTranslation();
  const insets = useSafeAreaInsets();
  const names = users.slice(0, 2).map(user => user.name).join('、');
  const summary = users.length > 2 ? t('{names}等 {count} 个', { names, count: users.length }) : names;
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={detail?.name ?? name} left={<Button testID="skill-back" intent="quiet" size="icon" accessibilityLabel={t('返回技能列表')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {banner}
    <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}>
      {loading ? <View className="mt-12"><LoadingState /></View> : null}
      {detail ? <>
        {detail.status === 'error' ? <View testID="skill-detail-error"><StatusBanner icon={CircleAlert} title={t('无法加载：{error}', { error: t(detail.error || '未知原因') })} /></View> : null}
        <ListGroup inset="content">
          <GroupRow title={t('位置')} trailing={<Text variant="caption" selectable className="max-w-[65%] text-right font-mono text-muted-foreground">{detail.path}</Text>} />
          <GroupRow title={t('最后修改时间')} value={detail.mtime === null ? t('不可用') : new Date(detail.mtime * 1000).toLocaleString(locale)} />
          {users.length ? <SurfacePressable testID="skill-users-summary" accessibilityRole="button"
            accessibilityLabel={users.length === 1 ? t('打开 {name} 资料', { name: users[0].name }) : t('查看使用此技能的 Agent：{names}', { names: summary })}
            onPress={() => users.length === 1 ? onUser(users[0]) : onUsers(true)} feedback="surface">
            <View className="min-h-15 flex-row items-center gap-3 px-4 py-3">
              <View className="flex-row pr-1">{users.slice(0, 3).map((user, index) => <View key={user.id} className={`rounded-full border-2 border-card ${index ? '-ml-2' : ''}`}><SkillUserAvatar user={user} /></View>)}</View>
              <Text variant="body" className="min-w-0 flex-1" numberOfLines={1}>{summary}</Text><Icon as={ChevronRight} size={16} className="text-muted-foreground/60" />
            </View>
          </SurfacePressable> : <Text variant="caption" className="px-4 py-4 text-muted-foreground">{t('没有 Agent 使用这个技能')}</Text>}
        </ListGroup>
        <View testID="skill-content" className="mx-4 mt-6">{detail.content !== null ? <AgentMemoryMarkdown content={skillMarkdown(detail)!} /> : <Text variant="caption" className="text-muted-foreground">{t('SKILL.md 不可读取；请检查上方错误原因。')}</Text>}</View>
        <View className="min-h-8 flex-1" />
        <Button testID="skill-delete" intent="destructive" className="mx-4" disabled={!selection.canDelete} onPress={onDeleteCheck}><Text>{t('删除技能')}</Text></Button>
      </> : null}
    </ScrollView>
    <Dialog open={selection.usersOpen} onOpenChange={onUsers}>
      <DialogContent placement="bottom" accessibilityLabel={t('使用它的 Agent')} testID="skill-users-sheet" overlayTestID="skill-users-backdrop" showCloseButton={false}>
        <DialogTitle className="sr-only" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{t('使用它的 Agent')}</DialogTitle>
        <ScrollView>{users.map(user => <GroupRow key={user.id} testID={`skill-agent-${user.id}`} title={user.name} leading={<SkillUserAvatar user={user} />}
          accessibilityLabel={t('打开 {name} 资料', { name: user.name })} affordance="navigate" onPress={() => onUser(user)} />)}</ScrollView>
      </DialogContent>
    </Dialog>
    <AlertDialog open={selection.dialog !== null} onOpenChange={open => { if (!open && !selection.deleting) onDeleteCancel(); }}>
      <AlertDialogContent>
        {selection.dialog === 'blocked' ? <>
          <AlertDialogHeader><AlertDialogTitle>{t('现在不能删除')}</AlertDialogTitle><AlertDialogDescription>{t('技能仍被 {names} 使用。先在对应 Agent 编辑里取消勾选，再删除技能。', { names: action.users.map(user => user.name).join('、') || 'Agent' })}</AlertDialogDescription></AlertDialogHeader>
          <Button testID="skill-delete-blocked" intent="soft" onPress={onDeleteCancel}><Text>{t('知道了')}</Text></Button>
        </> : <>
          <AlertDialogHeader><AlertDialogTitle>{t('删除{name}？', { name: detail?.name ?? name })}</AlertDialogTitle><AlertDialogDescription>{t('技能目录及其中的文件会被删除，无法恢复。只有不再被 Agent 使用时才能删除。')}</AlertDialogDescription></AlertDialogHeader>
          {action.error ? <Text testID="skill-delete-error" variant="caption" className="text-destructive">{t(action.error)}</Text> : null}
          <AlertDialogFooter>
            <AlertDialogCancel testID="skill-delete-cancel" disabled={selection.deleting}><Text>{t('取消')}</Text></AlertDialogCancel>
            <Button testID="skill-delete-confirm" intent="destructive" disabled={selection.deleting || !online} onPress={onDelete}><Text>{selection.deleting ? t('删除中…') : t('删除')}</Text></Button>
          </AlertDialogFooter>
        </>}
      </AlertDialogContent>
    </AlertDialog>
  </View>;
}

export function SkillUserAvatar({ user }: { user: SkillUser }) {
  return user.avatar === undefined ? <View className="size-7 items-center justify-center rounded-full bg-muted"><Icon as={UserRound} size={16} /></View>
    : <WandrunAvatar index={user.avatar} alt={user.name} size={28} />;
}

type BuiltinProps = { name: string; detail?: BuiltinSkillDetail; users: SkillUser[]; banner: ReactNode; loading: boolean; refreshing: boolean;
  onBack(): void; onRefresh(): void; onUser(user: SkillUser): void };
export function BuiltinSkillDetailView({ name, detail, users, banner, loading, refreshing, onBack, onRefresh, onUser }: BuiltinProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={detail?.name ?? name} left={<Button testID="builtin-detail-back" intent="quiet" size="icon" accessibilityLabel={t('返回技能列表')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {banner}
    <ScrollView testID="builtin-detail-screen" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}>
      {loading ? <View className="mt-12"><LoadingState /></View> : null}
      {detail ? <>
        {detail.description ? <Text variant="body" className="mx-4 mt-4">{detail.description}</Text> : null}
        <ListGroup inset="content"><GroupRow title={t('来源')} value={t('系统内置')} /><GroupRow title={t('所属能力')} trailing={<Text testID="builtin-capability" variant="caption" className="text-muted-foreground">{t(detail.capability.name)}</Text>} /></ListGroup>
        <ListGroup label={t('使用它的 Agent')} inset="content">{users.length ? users.map(user => <GroupRow key={user.id} testID={`builtin-agent-${user.id}`} title={user.name} leading={<SkillUserAvatar user={user} />}
          accessibilityLabel={t('打开 {name} 资料', { name: user.name })} affordance="navigate" onPress={() => onUser(user)} />) : <Text variant="caption" className="px-4 py-4 text-muted-foreground">{t('没有 Agent 使用这个技能')}</Text>}</ListGroup>
        <Text variant="caption" className="mx-4 mb-2 mt-6 text-muted-foreground">SKILL.md</Text>
        <View testID="builtin-skill-content" className="mx-4"><AgentMemoryMarkdown content={skillMarkdown({ status: 'ok', content: detail.content })!} /></View>
        <View className="min-h-8 flex-1" /><Text variant="caption" className="mx-4 mt-4 text-muted-foreground">{t('随 Wandrun 更新，不可编辑或删除。')}</Text>
      </> : null}
    </ScrollView>
  </View>;
}
