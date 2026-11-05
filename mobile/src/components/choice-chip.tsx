import type { ReactNode } from 'react';

import { SurfacePressable } from '@/components/ui/surface-pressable';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * 胶囊单选（design.md §3.6）：已选 primary、未选 soft（muted 底），文字随各自前景配对；视觉 36，hitSlop 补到 48。
 * leading 放 28 头像等标识。无障碍为 radio，selected 与画面同步。首个调用者：新对话 Agent 胶囊行（chat.N2）。
 */
export function ChoiceChip({ label, leading, selected, onPress, testID, disabled = false }: {
  label: string; leading?: ReactNode; selected: boolean; onPress(): void; testID?: string; disabled?: boolean;
}) {
  return <SurfacePressable testID={testID} disabled={disabled} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected, disabled }} hitSlop={6}
    onPress={onPress} className={cn('h-9 flex-row items-center gap-1.5 rounded-full pl-1 pr-3', selected ? 'bg-primary' : 'bg-muted')}>
    {leading}
    <Text variant="caption" numberOfLines={1} className={cn('max-w-[120px]', selected ? 'text-primary-foreground' : 'text-foreground')}>{label}</Text>
  </SurfacePressable>;
}
