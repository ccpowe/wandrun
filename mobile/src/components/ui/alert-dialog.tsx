import { Button } from '@/components/ui/button.tsx';
import { NativeOnlyAnimatedView } from '@/components/ui/native-only-animated-view.tsx';
import { TextClassContext } from '@/components/ui/text.tsx';
import { cn } from '@/lib/utils.ts';
import { dialogContentDelay, duration, easing, reduceMotion, webDuration } from '@/lib/motion.ts';
import * as AlertDialogPrimitive from '@rn-primitives/alert-dialog';
import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { FadeIn, FadeOut } from 'react-native-reanimated';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;

const filledDialogClass = 'bg-card z-50 flex w-full max-w-[360px] flex-col gap-5 rounded-lg border-0 p-5 shadow-sm shadow-foreground/5 sm:max-w-[360px]';
const alertSurfaces = { filled: filledDialogClass };

function AlertDialogOverlay({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Overlay>, 'asChild'> & {
    children?: React.ReactNode;
  }) {
  return (
    <FullWindowOverlay>
      <AlertDialogPrimitive.Overlay
        className={cn(
          'absolute bottom-0 left-0 right-0 top-0 z-50 flex items-center justify-center bg-black/50 p-2',
          Platform.select({
            web: 'animate-in fade-in-0 fixed',
          }),
          className
        )}
        {...props}
        asChild={Platform.OS !== 'web'}>
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(duration.base).delay(dialogContentDelay).easing(easing.standard).reduceMotion(reduceMotion)}
          exiting={FadeOut.duration(duration.exit).easing(easing.standard).reduceMotion(reduceMotion)}
          as="Pressable">
          <>{children}</>
        </NativeOnlyAnimatedView>
      </AlertDialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}

function AlertDialogContent({
  className,
  portalHost,
  overlayClassName,
  surface = 'filled',
  children,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
    portalHost?: string;
    overlayClassName?: string;
    surface?: 'filled';
  }) {
  return (
    <AlertDialogPortal hostName={portalHost}>
      <AlertDialogOverlay className={overlayClassName}>
        <AlertDialogPrimitive.Content
          className={cn(
            alertSurfaces[surface],
            Platform.select({
              web: `animate-in fade-in-0 zoom-in-95 web:max-w-[calc(100%-2rem)] ${webDuration.base}`,
            }),
            className
          )}
          {...props}
        >{children}</AlertDialogPrimitive.Content>
      </AlertDialogOverlay>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: ViewProps) {
  return (
    <TextClassContext.Provider value="text-center sm:text-left">
      <View className={cn('flex flex-col gap-2', className)} {...props} />
    </TextClassContext.Provider>
  );
}

function AlertDialogFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('text-foreground text-lg font-medium leading-6', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn('text-muted-foreground text-caption leading-5', className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  children,
  destructive = false,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> & { destructive?: boolean }) {
  return <AlertDialogPrimitive.Action {...props} asChild>
    <Button intent={destructive ? 'destructive' : 'soft'} disabled={props.disabled} className={cn('flex-1', className)}>
      {children as React.ReactNode}
    </Button>
  </AlertDialogPrimitive.Action>;
}

function AlertDialogCancel({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel {...props} asChild>
    <Button intent="soft" disabled={props.disabled} className={cn('flex-1', className)}>
      {children as React.ReactNode}
    </Button>
  </AlertDialogPrimitive.Cancel>;
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
