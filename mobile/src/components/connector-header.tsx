import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';

/** Detail / unbound catalog header: large icon, name, description and one status caption. */
export function ConnectorHeader({ icon, name, description, status }: { icon: ReactNode; name: string; description: string; status?: string }) {
  return <View className="items-center gap-3 px-8 pb-5 pt-4">
    {icon}
    <Text className="text-xl font-medium">{name}</Text>
    <Text variant="body" className="text-center text-muted-foreground">{description}</Text>
    {status ? <Text variant="caption" className="text-muted-foreground">{status}</Text> : null}
  </View>;
}
