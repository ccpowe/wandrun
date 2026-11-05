import { cn } from '@/lib/utils.ts';
import { Platform, TextInput } from 'react-native';

function Input({
  className,
  variant = 'filled',
  tone = 'card',
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput> & {
  variant?: 'filled';
  /** 页底字段用 card；已经在 card 内的字段用 muted。 */
  tone?: 'card' | 'muted';
}) {
  return (
    <TextInput
      className={cn(
        'text-foreground flex min-h-12 w-full min-w-0 flex-row items-center rounded-[12px] py-1',
        props.editable === false &&
          cn(
            'opacity-50',
            Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })
          ),
        Platform.select({
          web: cn(
            'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'
          ),
        }),
        variant === 'filled' && cn('border-0 px-4 text-body leading-5 shadow-none', tone === 'card' ? 'bg-card' : 'bg-muted'),
        className
      )}
      placeholderTextColorClassName="accent-muted-foreground"
      {...props}
    />
  );
}

export { Input };
