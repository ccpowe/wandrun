import * as SelectPrimitive from '@rn-primitives/select';
import * as React from 'react';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Check, ChevronDown } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon.tsx';
import { cn } from '@/lib/utils.ts';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

/** Filled field like `Input` (design §3.6): no outline; `tone="muted"` when the trigger already sits on a card. */
export function SelectTrigger({ className, children, tone = 'card', ...props }: Omit<React.ComponentProps<typeof SelectPrimitive.Trigger>, 'children'> & { children?: React.ReactNode; tone?: 'card' | 'muted' }) {
  return <SelectPrimitive.Trigger className={cn('min-h-12 flex-row items-center justify-between rounded-[12px] border-0 px-4',
    tone === 'card' ? 'bg-card' : 'bg-muted', props.disabled && 'opacity-50', className)} {...props}>
    {children}<Icon as={ChevronDown} className="text-muted-foreground size-4" />
  </SelectPrimitive.Trigger>;
}

export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const Overlay = Platform.OS === 'ios' ? FullWindowOverlay : React.Fragment;
  return <SelectPrimitive.Portal><Overlay>
    <SelectPrimitive.Overlay style={StyleSheet.absoluteFill}>
      <SelectPrimitive.Content side="bottom" align="start" sideOffset={4} avoidCollisions
        className={cn('bg-card max-h-64 min-w-48 rounded-lg border-0 p-1.5 shadow-sm shadow-foreground/5', className)} {...props}>
        {Platform.OS === 'web' ? <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport> :
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{ maxHeight: 256 }}>
            <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
          </ScrollView>}
      </SelectPrimitive.Content>
    </SelectPrimitive.Overlay>
  </Overlay></SelectPrimitive.Portal>;
}
export function SelectItem({ className, testID, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  // The web primitive's Item is a Radix DOM node; unlike Trigger it is not an RN Pressable.
  const identifier = Platform.OS === 'web' ? { 'data-testid': testID } : { testID };
  return <SelectPrimitive.Item className={cn('min-h-12 flex-row items-center justify-between rounded-md px-4 py-2', props.disabled && 'opacity-40', className)} {...identifier} {...props}>
    <SelectPrimitive.ItemText className="text-foreground text-sm" />
    <SelectPrimitive.ItemIndicator><Icon as={Check} className="text-foreground size-4" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}
