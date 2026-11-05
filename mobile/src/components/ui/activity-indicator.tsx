import type { ComponentProps } from 'react';
import { ActivityIndicator as NativeActivityIndicator } from 'react-native';
import { useCSSVariable } from 'uniwind';

/** Share the App's muted loading color; callers still own size, visibility and accessibility. */
export function ActivityIndicator(props: Omit<ComponentProps<typeof NativeActivityIndicator>, 'color'>) {
  const [muted] = useCSSVariable(['--color-muted-foreground']);
  return <NativeActivityIndicator {...props} color={String(muted)} />;
}
