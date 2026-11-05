import { Portal } from '@rn-primitives/portal';
import { BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import type GorhomBottomSheet from '@gorhom/bottom-sheet';
import { AlertCircle, Bot, CalendarClock, GitBranch, Monitor, Pencil, Search, Settings, SquarePen, Trash2 } from 'lucide-react-native';
import { useEffectEvent, useRef, type ComponentProps } from 'react';
import { BackHandler, ScrollView, View, type GestureResponderEvent } from 'react-native';
import type { TextInput } from 'react-native-gesture-handler';
import { KeyboardController } from 'react-native-keyboard-controller';
import { StatusBanner } from '@/components/status-banner.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import type { AgentSummary } from '@/gateway/api.ts';
import type { DrawerConversationGroup } from '@/lib/drawer-dates.ts';

import { ListRow } from '@/components/list-row.tsx';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog.tsx';
import { BottomSheet, BottomSheetInput } from '@/components/ui/bottom-sheet.tsx';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuAnchor, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { WandrunAvatar } from '@/components/wandrun-avatar.tsx';
import { formatActivityTime } from '@/lib/agent-list.ts';
import type { DrawerOverlay, DrawerTarget } from '@/lib/drawer-overlay.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';
import type { DrawerConversation } from './conversation-drawer.tsx';
import { TypingDots } from './typing-dots.tsx';

/** Static list geometry; no transformed ancestor clips the row. Pressability suppresses tap after long press. */
export function DrawerConversationRow({ conversation, selected, now, onSelect, onMenu }: {
  conversation: DrawerConversation; selected: boolean; now: Date;
  onSelect(): void; onMenu(event: GestureResponderEvent): void;
}) {
  const { t } = useTranslation();
  return <ListRow density="drawer" testID={`conversation-${conversation.id}`} selected={selected}
    title={conversation.title || t('新对话')} alert={conversation.unread}
    accessibilityLabel={`${conversation.title || t('新对话')}，${conversation.agent.name}${selected ? t('，当前对话') : ''}${conversation.source === 'schedule' ? `，${t('定时')}` : ''}${conversation.collaborationCount ? `，${t('{count} 个协作', { count: conversation.collaborationCount })}` : ''}`}
    onPress={onSelect} onLongPress={onMenu}
    trailing={!conversation.unread && conversation.running ? <TypingDots compact /> : null}
    subtitle={<>
      <WandrunAvatar index={conversation.agent.avatar} alt={conversation.agent.name} size={18} className="size-4" />
      <Text numberOfLines={1} className="min-w-0 shrink">{conversation.agent.name}</Text>
      {conversation.activityAt !== null ? <Text>{formatActivityTime(conversation.activityAt, now)}</Text> : null}
      {conversation.source === 'schedule' ? <Icon as={CalendarClock} size={13} className="text-muted-foreground" /> : null}
      {conversation.collaborationCount > 0 ? <><Icon as={GitBranch} size={13} className="text-muted-foreground" /><Text>{conversation.collaborationCount}</Text></> : null}
      {conversation.reason && conversation.source !== 'schedule' ? <Text numberOfLines={1} className="shrink">{conversation.reason}</Text> : null}
    </>} />;
}

function RenameBackdrop(props: BottomSheetBackdropProps & { busy: boolean; onClose(): void }) {
  const { busy, onClose, ...rest } = props;
  const { t } = useTranslation();
  // gorhom 5.2.14 omits its tap detector for "none"; keep only its visual / visibility behavior.
  return <BottomSheetBackdrop {...rest} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="none">
    <SurfacePressable testID="conversation-rename-backdrop" accessibilityRole="button" accessibilityLabel={t('关闭重命名')}
      disabled={busy} onPress={onClose} className="flex-1" />
  </BottomSheetBackdrop>;
}

/** Server-free presentation seam, also usable for hard-to-reach view stories. */
export function DrawerOverlays({ overlay, host, busy, canSubmit, onRename, onDelete, onDismissMenu, onCancel, onRenameClosing, onRenameClosed, onChange, onSubmit }: {
  overlay: DrawerOverlay | null; host: string; busy: boolean; canSubmit: boolean;
  onRename(): void; onDelete(): void; onDismissMenu(): void; onCancel(): void;
  onRenameClosing(target: DrawerTarget): boolean; onRenameClosed(target: DrawerTarget): void;
  onChange(title: string): void; onSubmit(): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const renaming = overlay?.status === 'renaming' || overlay?.status === 'saving' || overlay?.status === 'rename-closing';
  const deleting = overlay?.status === 'delete-confirm' || overlay?.status === 'deleting';
  return <>
    {overlay?.status === 'menu' ? <DropdownMenu onOpenChange={open => { if (!open) onDismissMenu(); }}>
      <DropdownMenuAnchor point={overlay.point} />
      <DropdownMenuContent portalHost={host} className="w-[220px]">
        <DropdownMenuItem testID="conversation-menu-rename" closeOnPress={false} icon={Pencil} accessibilityLabel={t('重命名对话')} onPress={onRename}><Text>{t('重命名')}</Text></DropdownMenuItem>
        <DropdownMenuItem testID="conversation-menu-delete" closeOnPress={false} icon={Trash2} variant="destructive" accessibilityLabel={t('删除对话')} onPress={onDelete}><Text>{t('删除')}</Text></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : null}
    {renaming ? <Portal hostName={host} name={`${host}-rename`}>
      <DrawerRenameSheet key={overlay.target.id} overlay={overlay} busy={busy} canSubmit={canSubmit}
        onClosing={onRenameClosing} onClosed={onRenameClosed} onChange={onChange} onSubmit={onSubmit} />
    </Portal> : null}
    <AlertDialog open={deleting} onOpenChange={open => { if (!open) onCancel(); }}>
      <AlertDialogContent portalHost={host}>
        <AlertDialogHeader><AlertDialogTitle>{t('删除这个对话？')}</AlertDialogTitle>
          <AlertDialogDescription>{t('正在进行的工作会停止；Agent 发给你的文件仍留在服务器上。')}</AlertDialogDescription></AlertDialogHeader>
        {overlay?.status === 'delete-confirm' && overlay.error ? <Text accessibilityRole="alert" variant="caption" className="text-destructive">{t(overlay.error)}</Text> : null}
        <AlertDialogFooter className="flex-row justify-end">
          <Button testID="conversation-delete-cancel" intent="soft" disabled={busy} onPress={onCancel}><Text>{t('取消')}</Text></Button>
          <Button testID="conversation-delete-confirm" intent="destructive" disabled={!canSubmit} onPress={() => void onSubmit()}><Text>{t('删除')}</Text></Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

/** The foundation's native close()/onClose contract owns exit; no timer or controlled-index substitute. */
function DrawerRenameSheet({ overlay, busy, canSubmit, onClosing, onClosed, onChange, onSubmit }: {
  overlay: Extract<DrawerOverlay, { status: 'renaming' | 'saving' | 'rename-closing' }>; busy: boolean; canSubmit: boolean;
  onClosing(target: DrawerTarget): boolean; onClosed(target: DrawerTarget): void; onChange(title: string): void; onSubmit(): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const input = useRef<TextInput>(null);
  const sheet = useRef<GorhomBottomSheet>(null);
  useMountEffect(() => {
    const field = input.current;
    return () => field?.blur();
  });
  const closeNative = async () => {
    if (!sheet.current) return;
    await KeyboardController.dismiss();
    sheet.current?.close();
  };
  const close = () => { if (onClosing(overlay.target)) void closeNative(); };
  const submit = async () => { if (await onSubmit()) await closeNative(); };
  const onBack = useEffectEvent(() => { if (!busy) close(); return true; });
  useMountEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  });
  // Public onAnimate reports the closed snap point; it is not a controlled index or a measured offset.
  return <BottomSheet ref={sheet}
    enablePanDownToClose={!busy} enableHandlePanningGesture={!busy} enableContentPanningGesture={!busy}
    backdropComponent={props => <RenameBackdrop {...props} busy={busy} onClose={close} />}
    onAnimate={(_from, to) => { if (to === -1) close(); }}
    onClose={() => { input.current?.blur(); onClosed(overlay.target); }}>
    <Text className="text-lg font-medium">{t('重命名')}</Text>
    <BottomSheetInput ref={input} testID="conversation-rename-input" accessibilityLabel={t('对话名称')} value={overlay.title}
      editable={!busy} onChangeText={onChange} selectTextOnFocus returnKeyType="done" onSubmitEditing={() => void submit()} />
    {overlay.status === 'renaming' && overlay.error ? <Text accessibilityRole="alert" variant="caption" className="text-destructive">{t(overlay.error)}</Text> : null}
    <View className="flex-row gap-3">
      <Button testID="conversation-rename-cancel" intent="quiet" className="flex-1" disabled={busy} onPress={close}><Text>{t('取消')}</Text></Button>
      <Button testID="conversation-rename-confirm" className="flex-1" disabled={!canSubmit} onPress={() => void submit()}><Text>{t('确定')}</Text></Button>
    </View>
  </BottomSheet>;
}

type DrawerPanelViewProps = {
  agents: readonly Pick<AgentSummary, 'id' | 'name' | 'avatar'>[]; connected: boolean; newConversationDisabled?: boolean;
  groups: readonly DrawerConversationGroup<DrawerConversation>[]; currentId?: string; now: Date;
  insets: { top: number; bottom: number }; loadError?: string;
  onNavigate(target: 'agents' | 'computer' | 'search' | 'settings'): void;
  onSelect(id: string): void; onNewConversation(): void;
  onMenu(conversation: DrawerConversation, event: GestureResponderEvent): void;
  overlays: ComponentProps<typeof DrawerOverlays>;
};

/** Presentation only: dates, rows and native overlays receive projected data and named callbacks. */
export function DrawerPanelView(props: DrawerPanelViewProps) {
  const { t } = useTranslation();
  const { connected, groups, currentId, now, insets } = props;
  const showReadError = useDelayedNotice(props.loadError ? 'collaborations' : null);
  return <View className="flex-1 bg-background" style={{ paddingTop: insets.top + 16 }}>
    <View className="px-6 pb-4 pt-3">
      <Text className="text-title font-semibold">Wandrun</Text>
      {!connected ? <Text testID="drawer-offline" className="mt-1 text-xs text-muted-foreground">{t('连接已断开，正在重连…')}</Text> : null}
      <View className="h-4" />
      {connected && props.loadError && showReadError ? <StatusBanner icon={AlertCircle} title={t('无法加载协作列表，正在重试…')} /> : null}
      <SurfacePressable testID="drawer-agents" accessibilityRole="button" accessibilityLabel="Agent"
        onPress={() => props.onNavigate('agents')} className="min-h-[52px] flex-row items-center gap-4">
        <Icon as={Bot} size={21} /><Text variant="body" className="flex-1">Agent</Text>
        <View className="flex-row pr-1">{props.agents.slice(0, 3).map((agent, index) => <View key={agent.id} style={{ marginLeft: index ? -8 : 0 }}>
          <WandrunAvatar index={agent.avatar} alt={agent.name} size={18} className="size-6" />
        </View>)}</View>
      </SurfacePressable>
      <SurfacePressable testID="drawer-computer" accessibilityRole="button" onPress={() => props.onNavigate('computer')} className="min-h-[52px] flex-row items-center gap-4">
        <Icon as={Monitor} size={21} /><Text variant="body">{t('服务器')}</Text>
      </SurfacePressable>
      <View className="mt-4 h-px bg-border/50" />
    </View>
    <ScrollView className="flex-1" onScrollBeginDrag={props.overlays.onDismissMenu} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
      {groups.length === 0 ? <Text variant="caption" className="px-6 py-6 text-muted-foreground">{t('还没有对话')}</Text> : null}
      {groups.map(group => <View key={group.date}>
        <Text variant="caption" className="px-6 pb-2 pt-4 text-muted-foreground">{t(group.date === 'today' ? '今天' : group.date === 'yesterday' ? '昨天' : '更早')}</Text>
        {group.conversations.map(conversation => <DrawerConversationRow key={conversation.id} conversation={conversation} selected={conversation.id === currentId} now={now}
          onSelect={() => props.onSelect(conversation.id)} onMenu={event => props.onMenu(conversation, event)} />)}
      </View>)}
    </ScrollView>
    <View className="flex-row items-center gap-2 px-3 pt-3" style={{ paddingBottom: Math.max(12, insets.bottom) }}>
      <SurfacePressable testID="drawer-search" accessibilityRole="button" accessibilityLabel={t('搜索 Agent、对话、消息、文件')} disabled={!connected}
        onPress={() => props.onNavigate('search')} className="h-12 min-w-0 flex-1 flex-row items-center gap-2 rounded-full bg-card px-4">
        <Icon as={Search} size={18} className="text-muted-foreground" /><Text variant="caption" className="text-muted-foreground">{t('搜索')}</Text>
      </SurfacePressable>
      <SurfacePressable testID="drawer-settings" accessibilityRole="button" accessibilityLabel={t('设置')} onPress={() => props.onNavigate('settings')} className="size-12 items-center justify-center rounded-full bg-card"><Icon as={Settings} size={21} /></SurfacePressable>
      <SurfacePressable testID="new-conversation" accessibilityRole="button" accessibilityLabel={t('新对话')} disabled={props.newConversationDisabled}
        onPress={props.onNewConversation} className="size-12 items-center justify-center rounded-full bg-primary disabled:opacity-50"><Icon as={SquarePen} size={21} className="text-primary-foreground" /></SurfacePressable>
    </View>
    <DrawerOverlays {...props.overlays} />
  </View>;
}
