import { IconDisabledContext } from '@/components/ui/icon';
import { TextClassContext } from '@/components/ui/text.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { cn } from '@/lib/utils.ts';
import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, Pressable } from 'react-native';

const softSurface = 'bg-muted dark:bg-secondary';

// Only rich-message still uses outline/ghost; its separate cleanup owns that final cutover.
const buttonVariants = cva(
  cn('group min-h-12 shrink-0 flex-row items-center justify-center gap-2 rounded-full border-0 shadow-none',
    Platform.select({ web: 'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px] disabled:pointer-events-none' })),
  {
    variants: {
      variant: { default: 'bg-primary', destructive: softSurface, outline: softSurface, secondary: softSurface, ghost: '' },
      size: { default: 'px-[22px] py-3', sm: 'px-[14px] py-3', lg: 'min-h-14 px-7 py-3', icon: 'size-12 p-0', 'icon-sm': 'size-8 min-h-0 p-0' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);
const buttonTextVariants = cva('text-sm font-normal', {
  variants: {
    variant: { default: 'text-primary-foreground', destructive: 'text-destructive', outline: 'text-muted-foreground', secondary: 'text-muted-foreground', ghost: 'text-muted-foreground' },
    size: { default: '', sm: '', lg: '', icon: '', 'icon-sm': '' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

type ButtonIntent = 'primary' | 'quiet' | 'soft' | 'destructive';
const intentVariants = { primary: 'default', quiet: 'ghost', soft: 'secondary', destructive: 'destructive' } as const;

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  Omit<VariantProps<typeof buttonVariants>, 'variant'> & {
    intent?: ButtonIntent;
    variant?: 'outline' | 'ghost';
    pressedPreview?: boolean;
  };

/** `icon-sm`：32 视觉的字段内图标按钮（发送 / 停止 / 取消引用等），默认 hitSlop 8 补足 48 触区。 */
const ICON_SM_HIT_SLOP = 8;

function Button({ className, variant, size, intent, pressedPreview, hitSlop, ...props }: ButtonProps) {
  const visualVariant = intent ? intentVariants[intent] : variant ?? 'default';
  const small = size === 'icon-sm';
  // 图标按钮（icon / icon-sm）的 quiet 禁用只把内容转为淡灰，不叠整体 50% 透明；文字按钮保持原禁用外观。
  // Icon 读 IconDisabledContext，禁用淡灰覆盖调用方写死的颜色类。
  const mutedDisabled = (small || size === 'icon') && visualVariant === 'ghost' && !!props.disabled;
  const textClass = buttonTextVariants({ variant: visualVariant, size });
  return (
    <IconDisabledContext.Provider value={mutedDisabled}>
    <TextClassContext.Provider value={mutedDisabled ? cn(textClass, 'text-muted-foreground/60') : textClass}>
      <SurfacePressable
        className={cn(buttonVariants({ variant: visualVariant, size }), props.disabled && !mutedDisabled && 'opacity-50', className)}
        overlayClassName={visualVariant === 'default' ? 'bg-primary-foreground/7' : undefined}
        pressedPreview={pressedPreview}
        role="button"
        hitSlop={hitSlop ?? (small ? ICON_SM_HIT_SLOP : undefined)}
        {...props}
      />
    </TextClassContext.Provider>
    </IconDisabledContext.Provider>
  );
}

export { Button };
export type { ButtonProps };
