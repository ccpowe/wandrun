import { ChevronLeft, ChevronUp, Menu, SquarePen } from 'lucide-react-native';
import { type ReactElement } from 'react';
import { View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { TypingDots } from './typing-dots.tsx';
import { CHAT_SPRINGS } from './chat-motion.ts';
import { ScreenBar } from '@/components/screen-bar.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import { Text } from '@/components/ui/text.tsx';
import { WandrunAvatar } from '@/components/wandrun-avatar.tsx';
import type { AgentSummary } from '@/gateway/api.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';

type Props = {
  agent: Pick<AgentSummary, 'id' | 'name' | 'avatar'> | undefined;
  subtitle: string;
  working: boolean;
  newConversationDisabled: boolean;
  onOpenConversations?: () => void;
  onNewConversation?: () => void;
  onAgentPress(): void;
  onChildrenPress?: () => void;
  onBack?: () => void;
  childCount?: number;
  childAttention?: boolean;
  cardExpanded?: boolean;
  wrapSideControl?: (control: ReactElement) => ReactElement;
};

/**
 * Transparent chat header on the shared ScreenBar skeleton (design.md §5): the name area only opens
 * the profile, the child-count badge is its own button; neither has a hidden long-press or swipe intent.
 */
export function ChatHeaderView({ agent, subtitle, working, newConversationDisabled, onOpenConversations, onNewConversation, onAgentPress, onChildrenPress, onBack, childCount = 0, childAttention = false, cardExpanded = false, wrapSideControl }: Props) {
  const { t } = useTranslation();
  const newDisabled = newConversationDisabled || !onNewConversation;
  const center = agent && <View className="max-w-full flex-row items-center">
    {/* No static surface; the 7% press overlay reveals the full pill. */}
    <SurfacePressable onPress={onAgentPress} className="min-h-12 min-w-0 shrink flex-row items-center gap-2.5 rounded-full px-3"
      accessibilityRole="button" accessibilityLabel={t('查看{agent}资料', { agent: agent.name })} testID="chat-agent-profile">
      <WandrunAvatar index={agent.avatar} alt={agent.name} size={28} />
      <View className="min-w-0 shrink">
        <Text variant="body" className="font-medium" numberOfLines={1} testID="chat-agent-name">{agent.name}</Text>
        <View className="min-w-0 flex-row items-center gap-1">
          {working && <TypingDots compact />}
          <Text className="min-w-0 shrink text-xs text-muted-foreground" numberOfLines={1} testID="chat-conversation-title">{subtitle}</Text>
        </View>
      </View>
    </SurfacePressable>
    {childCount > 0 && <Button intent="quiet" size="icon-sm" onPress={onChildrenPress} testID="chat-child-count" className="-ml-1"
      accessibilityLabel={t('子对话 {count}', { count: childCount })} accessibilityState={{ expanded: cardExpanded }}>
      <ChildCountBadge count={childCount} attention={childAttention} expanded={cardExpanded} />
    </Button>}
  </View>;
  const left = <Button intent="quiet" size="icon" testID={onBack ? 'chat-root-conversation' : 'chat-open-drawer'}
    onPress={onBack ?? onOpenConversations} disabled={!onBack && !onOpenConversations}
    accessibilityLabel={onBack ? t('返回主对话') : t('对话列表')}>
    <Icon as={onBack ? ChevronLeft : Menu} size={24} />
  </Button>;
  // A child conversation has no new-conversation action; an empty slot keeps the name centred.
  const right = onBack ? <View className="size-12" /> : <Button intent="quiet" size="icon" testID="chat-new-conversation"
    onPress={onNewConversation} disabled={newDisabled} accessibilityLabel={t('新对话')}>
    <Icon as={SquarePen} size={24} />
  </Button>;
  return <ScreenBar left={wrapSideControl ? wrapSideControl(left) : left} center={center}
    right={onBack || !wrapSideControl ? right : wrapSideControl(right)} />;
}

function ChildCountBadge({ count, attention, expanded }: { count: number; attention: boolean; expanded: boolean }) {
  const scale = useSharedValue(0.6);
  useMountEffect(() => {
    scale.set(withSpring(1, CHAT_SPRINGS.morph));
    return () => cancelAnimation(scale);
  });
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View className="relative size-6 items-center justify-center rounded-full bg-muted" style={style}>
    {expanded ? <Icon as={ChevronUp} size={14} className="text-foreground" /> : <Text className="text-xs font-medium text-foreground">{count}</Text>}
    {attention && <View testID="chat-child-attention" className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-destructive" />}
  </Animated.View>;
}
