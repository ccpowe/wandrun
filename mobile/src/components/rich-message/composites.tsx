import { Children, useContext, type ReactNode } from 'react';
import { View } from 'react-native';
import type { z } from 'zod';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import { useTranslation } from '../../lib/i18n.ts';
import { RichInteractionContext } from './inputs.tsx';
import { StatusBadge } from './display.tsx';
import { RichFieldContext } from './field-context.ts';
import { richIcons, type RichIconName } from './icons.tsx';
import type { componentSchemas } from './spec.ts';
import { richRadius, richSpace, richType } from './tokens.ts';

/** `StatCard.static`: the composite owns its appearance; its parent owns position and width. */
export function StatCardDisplay({ props, elementId }: { props: z.infer<typeof componentSchemas.StatCard>; elementId?: string }) {
  const { t } = useTranslation();
  const { submitted, submitDisabled, pending, send, actionId, sentActionId } = useContext(RichInteractionContext);
  const tappable = !!props.send && !submitted;
  const Surface = tappable ? SurfacePressable : View;
  return <Surface className={props.send ? 'bg-card border-border border rounded-lg' : 'bg-muted'}
    {...(tappable ? { accessibilityRole: 'button' as const, accessibilityLabel: props.label,
      accessibilityState: { disabled: submitDisabled, busy: pending && actionId === elementId }, disabled: submitDisabled,
      onPress: () => send!(elementId!) } : {})}
    style={{ borderRadius: props.send ? richRadius.large : richRadius.medium, padding: richSpace.lg, gap: richSpace.sm, minHeight: 48 }}>
    {props.icon || props.badge ? <View className="flex-row items-start justify-between" style={{ gap: richSpace.sm }}>
      {props.icon ? <Icon as={richIcons[props.icon as RichIconName]} size={20} className="text-muted-foreground" /> : <View />}
      {props.badge ? <View style={{ flexShrink: 1 }}><StatusBadge {...props.badge} /></View> : null}
    </View> : null}
    <Text style={richType.subtle} className="text-muted-foreground">{props.label}</Text>
    <Text style={richType.metric}>{String(props.value)}</Text>
    {props.description ? <Text style={richType.subtle} className="text-muted-foreground">{props.description}</Text> : null}
    {props.send && pending && actionId === elementId ? <Text variant="caption" className="text-muted-foreground">{t('正在发送…')}</Text> : null}
    {props.send && submitted && sentActionId === elementId ? <Text variant="caption" className="text-muted-foreground">{t('已选')}</Text> : null}
  </Surface>;
}

/** `Field.default`: one input; no duplicate visible labels, and no second state owner. */
export function FieldDisplay({ props, children }: { props: z.infer<typeof componentSchemas.Field>; children?: ReactNode }) {
  return <View testID="rich-field" style={{ gap: richSpace.sm, minWidth: 0 }}>
    <View className="flex-row items-baseline justify-between" style={{ gap: richSpace.md }}>
      <Text variant="caption" className="text-muted-foreground min-w-0 flex-1">{props.label}</Text>
      {props.value !== undefined ? <Text style={[richType.body, { fontWeight: '600', flexShrink: 1, textAlign: 'right' }]}>{String(props.value)}</Text> : null}
    </View>
    <RichFieldContext.Provider value={{ boundStateKey: (props as typeof props & { __boundStateKey?: string }).__boundStateKey }}>{children}</RichFieldContext.Provider>
  </View>;
}

/** ButtonRow.default: Copy keeps its natural width, the real Submit takes remaining space.
 * Child roles come from validated spec metadata, not React component inspection. */
export function ButtonRowDisplay({ props, children }: { props?: { __childTypes?: string[] }; children?: ReactNode }) {
  return <View testID="rich-button-row" className="flex-row items-start" style={{ gap: richSpace.sm, minWidth: 0 }}>
    {Children.toArray(children).map((child, index) => <View key={index}
      style={{ ...(props?.__childTypes?.[index] === 'Copy' ? { flexShrink: 1 } : { flex: 1 }), minWidth: 0 }}>{child}</View>)}
  </View>;
}
