import { BottomSheetBackdrop, useBottomSheet, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { Check, LayoutGrid } from 'lucide-react-native';
import { BackHandler, Keyboard, ScrollView, View, useWindowDimensions } from 'react-native';

import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { ChoiceChip } from '@/components/choice-chip.tsx';
import { BottomSheet } from '@/components/ui/bottom-sheet.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import { Text } from '@/components/ui/text.tsx';
import { WandrunAvatar } from '@/components/wandrun-avatar.tsx';
import type { AgentSummary } from '@/gateway/api.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { NEW_CHAT_CHIP_LIMIT, newChatChips } from '@/lib/new-chat-agents.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { cn } from '@/lib/utils.ts';

type PickerAgent = Pick<AgentSummary, 'id' | 'name' | 'avatar' | 'description'>;

/** The visit owner decides when the welcome display ends; keyboard hide never brings it back. */
export function NewChatAgentDisplay({ agent }: { agent: PickerAgent }) {
  return <View testID="new-chat-agent-display" className="items-center gap-2 px-8">
    <WandrunAvatar index={agent.avatar} alt={agent.name} size={88} />
    <Text className="text-center text-xl font-semibold" numberOfLines={2}>{agent.name}</Text>
    {!!agent.description && <Text variant="caption" className="text-center text-muted-foreground" numberOfLines={2}>{agent.description}</Text>}
  </View>;
}

/**
 * chat.N2: recent Agents as chips above the composer (sketch C, `visual-sketch/agent-picker` chips-*), at most five,
 * scrolling sideways when they do not fit; more Agents add “all N”. The row moves up with the composer and stays
 * usable while the keyboard is open (taps keep the keyboard). The native horizontal scroll blocks the drawer pan via
 * the project's DrawerHorizontalGesture, so a swipe that starts on the row belongs to the row (accepted 2026-11-01).
 */
export function NewChatAgentChips({ recent, selectedId, onSelect, onOpenAll, disabled = false }: {
  /** All Agents in recent order (`recentAgentOrder`). */
  recent: readonly PickerAgent[]; selectedId: string; onSelect(id: string): void; onOpenAll(): void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const visible = newChatChips(recent, selectedId);
  if (!visible.length) return null;
  return <DrawerHorizontalGesture>
    {/* A new leading chip (picked from “all”) remounts the row at its left edge so the selection is visible. */}
    <ScrollView key={visible[0].id} testID="new-chat-agent-chips" horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      accessibilityRole="radiogroup" accessibilityLabel={t('选择 Agent')}
      contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 8 }}>
      {visible.map(agent => <ChoiceChip key={agent.id} disabled={disabled} testID={`new-chat-agent-${agent.id}`} label={agent.name} selected={agent.id === selectedId}
        leading={<WandrunAvatar index={agent.avatar} alt={agent.name} size={28} />} onPress={() => onSelect(agent.id)} />)}
      {recent.length > NEW_CHAT_CHIP_LIMIT && <SurfacePressable testID="new-chat-agent-all" disabled={disabled} accessibilityRole="button" hitSlop={6}
        accessibilityLabel={t('全部 {count} 个 Agent', { count: recent.length })}
        onPress={() => { Keyboard.dismiss(); onOpenAll(); }} className="h-9 flex-row items-center gap-1.5 rounded-full bg-muted px-3">
        <Icon as={LayoutGrid} size={16} className="text-muted-foreground" />
        <Text variant="caption">{t('全部 {count}', { count: recent.length })}</Text>
      </SurfacePressable>}
    </ScrollView>
  </DrawerHorizontalGesture>;
}

function Backdrop(props: BottomSheetBackdropProps) {
  return <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />;
}

/** Four columns, 52 avatar and one line of name; the current Agent carries a check at the avatar's corner. */
function AgentGrid({ agents, selectedId, onSelect }: { agents: readonly PickerAgent[]; selectedId: string; onSelect(id: string): void }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const { close } = useBottomSheet();
  // chat.N16 (待确认): while the sheet is open, hardware back only closes it, like back closing an open drawer first.
  useMountEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => listener.remove();
  });
  const cell = (width - 32) / 4;
  return <>
    <Text className="pb-1 text-lg font-medium leading-6">{t('全部 Agent')}</Text>
    <View className="mt-3 flex-row flex-wrap">
      {agents.map(agent => {
        const current = agent.id === selectedId;
        return <SurfacePressable key={agent.id} testID={`new-chat-agent-grid-${agent.id}`} accessibilityRole="radio" accessibilityLabel={agent.name}
          accessibilityState={{ selected: current }} onPress={() => { onSelect(agent.id); close(); }}
          className="items-center gap-1.5 rounded-lg py-3" style={{ width: cell }}>
          <View>
            <WandrunAvatar index={agent.avatar} alt={agent.name} size={52} />
            {current && <View className="absolute -bottom-0.5 -right-0.5 size-5 items-center justify-center rounded-full border-2 border-page-surface bg-primary">
              <Icon as={Check} size={11} className="text-primary-foreground" />
            </View>}
          </View>
          <Text variant="caption" numberOfLines={1} className={cn('px-1 text-center', current && 'font-medium')}>{agent.name}</Text>
        </SurfacePressable>;
      })}
    </View>
  </>;
}

/** chat.N2 “all” sheet in shared recent order; chat.N16: the caller closes it on hardware back. Height grows with content up to 80 %. */
export function NewChatAgentSheet({ agents, selectedId, onSelect, onClosed }: {
  agents: readonly PickerAgent[]; selectedId: string; onSelect(id: string): void; onClosed(): void;
}) {
  const { height } = useWindowDimensions();
  return <BottomSheet layout="scroll" index={0} enablePanDownToClose maxDynamicContentSize={Math.round(height * 0.8)}
    backdropComponent={Backdrop} onClose={onClosed}>
    <AgentGrid agents={agents} selectedId={selectedId} onSelect={onSelect} />
  </BottomSheet>;
}
