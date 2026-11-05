import type { ComponentProps, ReactNode } from 'react';
import { View } from 'react-native';
import { Check, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react-native';
import Animated, { useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/lib/i18n';
import { duration, easing, reduceMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';

type Props = Pick<ComponentProps<typeof SurfacePressable>, 'testID' | 'onPress' | 'onLongPress' | 'disabled' | 'pressedPreview' | 'accessibilityLabel'> & {
  title: string;
  description?: string;
  icon?: LucideIcon;
  leading?: ReactNode;
  value?: string;
  loading?: boolean;
  alert?: boolean;
  trailing?: ReactNode;
  density?: 'compact';
  affordance?: 'navigate' | 'disclose' | 'none' | 'selected';
  expanded?: boolean;
  selected?: boolean;
  className?: string;
};

function DisclosureArrow({ expanded }: { expanded: boolean }) {
  const rotation = useDerivedValue(() => withTiming(expanded ? 180 : 0, { duration: duration.base, easing: easing.standard, reduceMotion }), [expanded]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return <Animated.View style={style}><Icon as={ChevronDown} size={16} className="text-muted-foreground/60" /></Animated.View>;
}

/** 设置 / 表单分组行，与首页头像双行 ListRow 的 compact 语义分开。 */
export function GroupRow({ title, description, icon, leading, value, loading, alert, trailing, density = 'compact', affordance = 'none', expanded = false, selected, className, onPress, onLongPress, disabled, pressedPreview, ...props }: Props) {
  const { t } = useTranslation();
  const content = <View className={cn('flex-row items-center gap-3 px-4 py-2', density === 'compact' && (description ? 'min-h-[60px]' : 'min-h-[50px]'))}>
    {leading ?? (icon ? <Icon as={icon} size={20} className="text-muted-foreground" /> : null)}
    <View className="min-w-0 flex-1 gap-0.5">
      <Text variant="body" numberOfLines={1}>{title}</Text>
      {description ? <Text variant="caption" numberOfLines={1} className="text-muted-foreground">{description}</Text> : null}
    </View>
    {alert ? <View accessibilityLabel={t('需要处理')} className="size-1.5 rounded-full bg-destructive" /> : null}
    {loading ? <View accessibilityLabel={t('正在读取')} className="h-3 w-12 rounded-full bg-muted" /> : value ? <Text variant="caption" numberOfLines={1} className="max-w-[45%] shrink text-right text-muted-foreground">{value}</Text> : null}
    {affordance === 'selected' ? (selected ? <Icon as={Check} size={20} /> : null)
      : trailing ?? (affordance === 'disclose' ? <DisclosureArrow expanded={expanded} />
        : affordance === 'navigate' ? <Icon as={ChevronRight} size={16} className="text-muted-foreground/60" /> : null)}
  </View>;
  // 只读行和开关行不是整行按钮；开关 / 文字动作独占 trailing 的交互。
  if (!onPress && !onLongPress) return <View testID={props.testID} accessibilityLabel={props.accessibilityLabel} className={cn('overflow-hidden', className)}>{content}{pressedPreview && !disabled ? <View pointerEvents="none" className="absolute inset-0 bg-surface-pressed" /> : null}</View>;
  return <SurfacePressable {...props} onPress={onPress} onLongPress={onLongPress} disabled={disabled} feedback="surface" pressedPreview={pressedPreview}
    accessibilityRole={affordance === 'selected' ? 'radio' : 'button'}
    accessibilityLabel={props.accessibilityLabel ?? title}
    accessibilityState={{ disabled: disabled ?? undefined, expanded: affordance === 'disclose' ? expanded : undefined, selected, checked: affordance === 'selected' ? selected : undefined }}
    className={className}>{content}</SurfacePressable>;
}
