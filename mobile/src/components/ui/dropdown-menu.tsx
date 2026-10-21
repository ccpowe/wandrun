import { Icon } from '@/components/ui/icon.tsx';
import { NativeOnlyAnimatedView } from '@/components/ui/native-only-animated-view.tsx';
import { TextClassContext } from '@/components/ui/text.tsx';
import { cn } from '@/lib/utils.ts';
import { placeMenu } from '@/components/ui/menu-position.ts';
import * as DropdownMenuPrimitive from '@rn-primitives/dropdown-menu';
import { Check, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react-native';
import * as React from 'react';
import {
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/** Opens at a gesture's page coordinates, without measuring a placeholder in the document flow. */
function DropdownMenuAnchor({ point }: { point: { pageX: number; pageY: number } }) {
  const context = DropdownMenuPrimitive.useRootContext();
  const webTrigger = React.useRef<DropdownMenuPrimitive.TriggerRef>(null);
  const openAtPoint = React.useEffectEvent(() => {
    if (Platform.OS === 'web') {
      webTrigger.current?.open();
    } else {
      context.setTriggerPosition({ pageX: point.pageX, pageY: point.pageY, width: 0, height: 0 });
      context.onOpenChange(true);
    }
  });
  React.useLayoutEffect(() => { openAtPoint(); }, [point]);
  // Radix measures a DOM anchor; keep it at the touch point, outside normal flow.
  if (Platform.OS === 'web') return <DropdownMenuPrimitive.Trigger ref={webTrigger}
    accessible={false} tabIndex={-1} className="fixed"
    style={{ left: point.pageX - window.scrollX, top: point.pageY - window.scrollY, width: 0, height: 0 }} />;
  return null;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  iconClassName,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
    children?: React.ReactNode;
    iconClassName?: string;
    inset?: boolean;
  }) {
  const { open } = DropdownMenuPrimitive.useSubContext();
  const icon = Platform.OS === 'web' ? ChevronRight : open ? ChevronUp : ChevronDown;
  return (
    <TextClassContext.Provider
      value={cn(
        'text-sm select-none group-active:text-accent-foreground',
        open && 'text-accent-foreground'
      )}>
      <DropdownMenuPrimitive.SubTrigger
        className={cn(
          'active:bg-accent group flex flex-row items-center justify-between rounded-sm px-2 py-2 sm:py-1.5',
          Platform.select({
            web: 'focus:bg-accent focus:text-accent-foreground cursor-default outline-none [&_svg]:pointer-events-none',
          }),
          className,
          open && 'bg-accent',
          inset && 'pl-8'
        )}
        {...props}>
        <>{children}</>
        <Icon as={icon} className={cn('text-foreground size-4 shrink-0', iconClassName)} />
      </DropdownMenuPrimitive.SubTrigger>
    </TextClassContext.Provider>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <NativeOnlyAnimatedView entering={FadeIn.reduceMotion(ReduceMotion.System)}>
      <DropdownMenuPrimitive.SubContent
        className={cn(
          'bg-popover border-border overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5',
          Platform.select({
            web: 'animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fade-in-0 data-[state=closed]:zoom-out-95 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-context-menu-content-transform-origin) z-50 min-w-[8rem]',
          }),
          className
        )}
        {...props}
      />
    </NativeOnlyAnimatedView>
  );
}
const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;

type MenuContentProps = React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  overlayStyle?: StyleProp<ViewStyle>;
  overlayClassName?: string;
  overlayTestID?: string;
  portalHost?: string;
};

function NativeDropdownMenuContent({
  className,
  overlayClassName,
  overlayStyle,
  overlayTestID,
  align = 'start',
  side = 'bottom',
  sideOffset = 0,
  alignOffset = 0,
  avoidCollisions = true,
  insets,
  style,
  children,
  ...props
}: MenuContentProps) {
  const { triggerPosition, contentLayout } = DropdownMenuPrimitive.useRootContext();
  const safeArea = useSafeAreaInsets();
  const overlayRef = React.useRef<React.ElementRef<typeof DropdownMenuPrimitive.Overlay>>(null);
  const [viewport, setViewport] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // The root KeyboardProvider's translucent bars make height include the bottom
  // system inset. Do not mix RN keyboard screenY with measureInWindow coordinates.
  const keyboardHeight = useKeyboardState((state) => state.isVisible ? state.height : 0);

  const placement = triggerPosition && contentLayout && viewport
    ? placeMenu({
      trigger: { x: triggerPosition.pageX, y: triggerPosition.pageY, width: triggerPosition.width, height: triggerPosition.height },
      content: contentLayout,
      viewport,
      insets: insets ?? safeArea,
      keyboardHeight,
      side, align, sideOffset, alignOffset, avoidCollisions,
    })
    : { position: 'absolute' as const, opacity: 0 };

  return (
    <DropdownMenuPrimitive.Overlay
      ref={overlayRef}
      testID={overlayTestID}
      style={overlayStyle
        ? StyleSheet.flatten([StyleSheet.absoluteFill, overlayStyle as typeof StyleSheet.absoluteFill])
        : StyleSheet.absoluteFill}
      className={overlayClassName}
      onLayout={() => {
        // The portal's measured bounds may differ from Dimensions.get('screen').
        // Trigger and overlay use the same page coordinates; no screen/window conversion.
        overlayRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
          if (width && height) setViewport((old) =>
            old?.x === pageX && old.y === pageY && old.width === width && old.height === height
              ? old : { x: pageX, y: pageY, width, height });
        });
      }}
      asChild>
      <NativeOnlyAnimatedView entering={FadeIn.reduceMotion(ReduceMotion.System)} as="Pressable">
        <TextClassContext.Provider value="text-popover-foreground">
          <DropdownMenuPrimitive.Content
            disablePositioningStyle
            align={align}
            side={side}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
            avoidCollisions={avoidCollisions}
            insets={insets ?? safeArea}
            className={cn('bg-popover border-border min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5', className)}
            style={{ ...placement, ...style }}
            {...props}>
            {typeof children === 'function'
              ? (state) => <ScrollView keyboardShouldPersistTaps="always" style={{ flexShrink: 1 }}>{children(state)}</ScrollView>
              : <ScrollView keyboardShouldPersistTaps="always" style={{ flexShrink: 1 }}>{children}</ScrollView>}
          </DropdownMenuPrimitive.Content>
        </TextClassContext.Provider>
      </NativeOnlyAnimatedView>
    </DropdownMenuPrimitive.Overlay>
  );
}

function DropdownMenuContent({
  className,
  overlayClassName,
  overlayStyle,
  overlayTestID = 'menu-backdrop',
  portalHost,
  ...props
}: MenuContentProps) {
  if (Platform.OS !== 'web') {
    return <DropdownMenuPrimitive.Portal hostName={portalHost}>
      <FullWindowOverlay>
        <NativeDropdownMenuContent
          className={className}
          overlayClassName={overlayClassName}
          overlayStyle={overlayStyle}
          overlayTestID={overlayTestID}
          {...props}
        />
      </FullWindowOverlay>
    </DropdownMenuPrimitive.Portal>;
  }
  return (
    <DropdownMenuPrimitive.Portal hostName={portalHost}>
      <DropdownMenuPrimitive.Overlay
        testID={overlayTestID}
        style={overlayStyle ?? undefined}
        className={overlayClassName}>
        <TextClassContext.Provider value="text-popover-foreground">
          <DropdownMenuPrimitive.Content
            className={cn(
              'bg-popover border-border min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5',
              'animate-in fade-in-0 zoom-in-95 max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) z-50 cursor-default',
              props.side === 'bottom' && 'slide-in-from-top-2',
              props.side === 'top' && 'slide-in-from-bottom-2',
              className
            )}
            {...props}
          />
        </TextClassContext.Provider>
      </DropdownMenuPrimitive.Overlay>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
    className?: string;
    inset?: boolean;
    variant?: 'default' | 'destructive';
  }) {
  return (
    <TextClassContext.Provider
      value={cn(
        'select-none text-sm text-popover-foreground group-active:text-popover-foreground',
        variant === 'destructive' && 'text-destructive group-active:text-destructive'
      )}>
      <DropdownMenuPrimitive.Item
        className={cn(
          'active:bg-accent group relative flex flex-row items-center gap-2 rounded-sm px-2 py-2 sm:py-1.5',
          Platform.select({
            web: cn(
              'focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none',
              variant === 'destructive' && 'focus:bg-destructive/10 dark:focus:bg-destructive/20'
            ),
          }),
          variant === 'destructive' && 'active:bg-destructive/10 dark:active:bg-destructive/20',
          props.disabled && 'opacity-50',
          inset && 'pl-8',
          className
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
    children?: React.ReactNode;
  }) {
  return (
    <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
      <DropdownMenuPrimitive.CheckboxItem
        className={cn(
          'active:bg-accent group relative flex flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 sm:py-1.5',
          Platform.select({
            web: 'focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none',
          }),
          props.disabled && 'opacity-50',
          className
        )}
        {...props}>
        <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
          <DropdownMenuPrimitive.ItemIndicator>
            <Icon
              as={Check}
              className={cn(
                'text-foreground size-4',
                Platform.select({ web: 'pointer-events-none' })
              )}
            />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
        <>{children}</>
      </DropdownMenuPrimitive.CheckboxItem>
    </TextClassContext.Provider>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
    children?: React.ReactNode;
  }) {
  return (
    <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
      <DropdownMenuPrimitive.RadioItem
        className={cn(
          'active:bg-accent group relative flex flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 sm:py-1.5',
          Platform.select({
            web: 'focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none',
          }),
          props.disabled && 'opacity-50',
          className
        )}
        {...props}>
        <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
          <DropdownMenuPrimitive.ItemIndicator>
            <View className="bg-foreground h-2 w-2 rounded-full" />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
        <>{children}</>
      </DropdownMenuPrimitive.RadioItem>
    </TextClassContext.Provider>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
    className?: string;
    inset?: boolean;
  }) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        'text-foreground px-2 py-2 text-sm font-medium sm:py-1.5',
        inset && 'pl-8',
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<typeof Text>) {
  return (
    <Text
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuAnchor,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
