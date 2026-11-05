import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';

/** Instruction step: muted number disc + body text; children may nest inline Text such as CommandText. */
export function NumberedStep({ index, children }: { index: number; children: ReactNode }) {
  return <View className="flex-row items-center gap-3">
    <View className="size-7 items-center justify-center rounded-full bg-muted"><Text className="text-xs font-medium">{index}</Text></View>
    <Text variant="body" className="flex-1">{children}</Text>
  </View>;
}
