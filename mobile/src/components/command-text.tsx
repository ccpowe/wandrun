import { Text } from '@/components/ui/text';

/** Inline command inside running text (must be nested in a Text): monospace on a muted tint. Never translated. */
export function CommandText({ children }: { children: string }) {
  return <Text className="rounded-sm bg-muted font-mono text-[14px] text-foreground">{` ${children} `}</Text>;
}
