import { ScrollView, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useCSSVariable } from 'uniwind';

import { TypingDots } from './typing-dots.tsx';
import { ListGroup } from '../list-group.tsx';
import { ListRow } from '../list-row.tsx';
import { Text } from '../ui/text.tsx';
import { WandrunAvatar } from '../wandrun-avatar.tsx';
import type { AgentSummary } from '../../gateway/api.ts';
import type { TaskView } from '../../gateway/session.ts';
import { formatActivityTime } from '../../lib/agent-list.ts';
import { useTranslation } from '../../lib/i18n.ts';

const TASK_LABEL = { running: '进行中', waiting: '等待成员结果', completed: '已完成', failed: '失败', cancelled: '已停止', unavailable: '无法继续' } as const;
/** Standard compact two-line row (design.md §3.5) plus its 1dp inset divider. */
const ROW_HEIGHT = 60;
const DIVIDER = 1;
const CARD_WIDTH = 320;

export type ConversationCardTask = {
  id: string; title: string; member: Pick<AgentSummary, 'name' | 'avatar'>;
  status: TaskView['status'] | 'requested'; activityAt: number; attention: boolean; working: boolean;
};

/**
 * Child list under the header: a menu-like filled overlay (320 wide, centred, soft shadow) holding the
 * standard grouped list. Natural height up to three rows; the native ScrollView owns longer lists.
 */
export function ConversationCard({ tasks, progress, now, onSelect }: {
  tasks: ConversationCardTask[]; progress: SharedValue<number>; now: Date;
  onSelect(id: string): void;
}) {
  const { t } = useTranslation();
  const [card] = useCSSVariable(['--color-card']);
  const style = useAnimatedStyle(() => ({ opacity: Math.max(0, Math.min(1, progress.value)), transform: [{ scale: 0.88 + 0.12 * progress.value }, { translateY: -12 * (1 - progress.value) }] }));
  const visible = Math.min(tasks.length, 3);
  return <Animated.View testID="chat-conversation-card" className="max-w-full self-center rounded-lg bg-card shadow-sm shadow-foreground/5"
    style={[{ width: CARD_WIDTH, elevation: 3, transformOrigin: 'top' }, style]}>
    <View className="overflow-hidden rounded-lg" style={{ height: visible * ROW_HEIGHT + (visible - 1) * DIVIDER }}>
      <ScrollView testID="chat-card-list" nestedScrollEnabled scrollEnabled={tasks.length > 3} keyboardShouldPersistTaps="handled">
        <ListGroup surface="filled" divider="inset" className="-mx-4 mt-0">
          {tasks.map((task) => {
            const status = task.status === 'requested' ? t('等你接管') : t(TASK_LABEL[task.status]);
            const title = task.title || t('新对话');
            const time = formatActivityTime(task.activityAt, now);
            // The row announces everything it shows: title, member · status · time and the attention dot.
            const label = t(task.attention ? '{title}，{member} · {status} · {time}，需要处理' : '{title}，{member} · {status} · {time}',
              { title, member: task.member.name, status, time });
            return <ListRow key={task.id} testID={`chat-child-${task.id}`} title={title}
              accessibilityLabel={label} alert={task.attention} onPress={() => onSelect(task.id)}
              leading={<WandrunAvatar index={task.member.avatar} alt={task.member.name} size={28} />}
              trailing={!task.attention && task.working ? <TypingDots compact /> : undefined}
              subtitle={<Text numberOfLines={1} className="shrink">{task.member.name} · {status} · {time}</Text>} />;
          })}
        </ListGroup>
      </ScrollView>
      {tasks.length > 3 && <LinearGradient pointerEvents="none" colors={['transparent', typeof card === 'string' ? card : 'transparent']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 20 }} />}
    </View>
  </Animated.View>;
}
