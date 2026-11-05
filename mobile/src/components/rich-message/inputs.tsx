import { createContext, useContext, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import SliderControl from '@react-native-community/slider';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useStateStore } from '@json-render/react-native';
import * as SelectPrimitive from '@rn-primitives/select';
import { useCSSVariable } from 'uniwind';
import { CalendarDays, Check, X } from 'lucide-react-native';
import type { z } from 'zod';
import { DrawerNativeControlGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Select, SelectContent, SelectTrigger } from '@/components/ui/select.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import { Switch as SwitchUI } from '@/components/ui/switch.tsx';
import { Text as UIText } from '@/components/ui/text.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useTranslation } from '../../lib/i18n.ts';
import { RichFramedContext } from './framed-context.ts';
import { RichFieldContext } from './field-context.ts';
import { RichText } from './math.tsx';
import { alignedSliderValue, componentSchemas, displayFieldValue, pointerForKey } from './spec.ts';
import { richSpace, richType } from './tokens.ts';

/**
 * Form controls of a `wandrun-ui` block (ADR-0081 step 1b). Inputs reuse the foundation variants:
 * filled fields (muted inside the framed card), primary submit, primary/soft chips, text-segment look.
 * Read-only and display components stay in `registry.tsx`.
 */

/** Foundation touch target (design §3.4); visuals may be smaller and use hitSlop. */
const TOUCH = 48;
const ICON = 20;

type Interaction = {
  submitted: boolean; disabled: boolean; submitDisabled: boolean; pending: boolean; submit: () => void; submittedAt: string | null;
  send?: (actionId: string) => void; actionId?: string; sentActionId?: string;
};
export const RichInteractionContext = createContext<Interaction>({ submitted: false, disabled: false, submitDisabled: false, pending: false, submit: () => {}, submittedAt: null });

export { RichFramedContext };

/** The renderer, not the model, decides the frame: card fill + 1px border + lg radius + 16 padding. */
export function RichFramed({ framed, children }: { framed: boolean; children: ReactNode }) {
  if (!framed) return children;
  return <View testID="rich-framed" className="bg-card border-border rounded-lg border p-4" style={{ gap: richSpace.md }}>
    <RichFramedContext.Provider value={true}>{children}</RichFramedContext.Provider>
  </View>;
}

const Caption = ({ children, className = 'text-muted-foreground' }: { children: ReactNode; className?: string }) =>
  <UIText variant="caption" className={className}>{children}</UIText>;
const FieldLabel = ({ children }: { children: string }) => useContext(RichFieldContext) ? null : <Caption>{children}</Caption>;

type FieldType = 'ChoiceGroup' | 'Select' | 'Segmented' | 'MultiSelect' | 'Switch' | 'Slider' | 'TextInput' | 'DateInput';
/** Submitted: the boundary stays, each control becomes caption label + body value. */
function SelectedField({ stateKey, label, type, options }: { stateKey: string; label: string; type: FieldType; options?: { value: string; label: string }[] }) {
  const { state } = useStateStore();
  const field = useContext(RichFieldContext);
  if (field && field.boundStateKey === stateKey) return null;
  return <View style={{ gap: richSpace.xs }}><FieldLabel>{label}</FieldLabel>
    <RichText className="text-foreground" style={richType.body}>{displayFieldValue(type, options, state[stateKey])}</RichText></View>;
}

type ChoiceProps = z.infer<typeof componentSchemas.ChoiceGroup>;
/** One row per option, selected = trailing check (same as GroupRow affordance="selected"); no outline frames. */
export function ChoiceGroupField({ props }: { props: ChoiceProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="ChoiceGroup" label={label} stateKey={props.stateKey} options={props.options} />;
  return <View style={{ gap: richSpace.xs }}><FieldLabel>{label}</FieldLabel>
    <View accessibilityRole="radiogroup" accessibilityLabel={label} className={disabled ? 'opacity-50' : undefined}>
      {props.options.map((option, index) => {
        const selected = state[props.stateKey] === option.value;
        const unavailable = disabled || !!option.disabled;
        const detail = [...(option.tags ?? []), ...(option.description ? [option.description] : [])].join(' · ');
        return <SurfacePressable key={option.value} disabled={unavailable}
          onPress={() => { if (!unavailable) set(pointerForKey(props.stateKey), option.value); }}
          accessibilityRole="radio" accessibilityLabel={`${label}：${option.label}`}
          accessibilityHint={option.disabled ? t('暂不可用') : undefined}
          accessibilityState={{ checked: selected, disabled: unavailable }} testID={`rich-choice-${props.stateKey}-${option.value}`}
          className={`flex-row items-center ${index ? 'border-border/50 border-t' : ''}`}
          style={{ minHeight: TOUCH, gap: richSpace.md, paddingVertical: richSpace.sm }}>
          <View className="min-w-0 flex-1">
            <RichText pointerEvents="none" className={option.disabled ? 'text-muted-foreground' : 'text-foreground'}
              style={[richType.body, selected && { fontWeight: '500' }]}>{option.label}</RichText>
            {detail ? <Caption>{detail}</Caption> : null}
          </View>
          {selected ? <Icon as={Check} size={ICON} className="text-foreground" /> : <View style={{ width: ICON }} />}
        </SurfacePressable>;
      })}
    </View></View>;
}

type SelectProps = z.infer<typeof componentSchemas.Select>;
/** Trigger padding 16 + chevron 16; the clear target sits left of the chevron without nesting buttons. */
const SELECT_CLEAR_RIGHT = 24;
const SELECT_TEXT_RESERVE = 40;
export function SelectField({ props }: { props: SelectProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="Select" label={label} stateKey={props.stateKey} options={props.options} />;
  const selected = props.options.find((option) => option.value === state[props.stateKey]);
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{label}</FieldLabel>
    <View className="relative">
      <Select value={selected ? { value: selected.value, label: selected.label } : { value: '', label: t('请选择') }}
        disabled={disabled} onValueChange={(option) => {
          if (!disabled && option && props.options.some((item) => item.value === option.value && !item.disabled))
            set(pointerForKey(props.stateKey), option.value);
        }}>
        <SelectTrigger tone="muted" disabled={disabled} accessibilityLabel={label} testID={`rich-select-${props.stateKey}`}>
          <UIText variant="body" pointerEvents="none" className={`${selected ? 'text-foreground' : 'text-muted-foreground'} min-w-0 flex-1`}
            style={{ paddingRight: selected ? SELECT_TEXT_RESERVE : richSpace.sm }} numberOfLines={1}>{selected?.label || t('请选择')}</UIText>
        </SelectTrigger>
        <SelectContent sideOffset={richSpace.xs}>
          {props.options.map((option) => <SelectPrimitive.Item key={option.value} value={option.value} label={option.label}
            disabled={disabled || option.disabled} {...(Platform.OS === 'web'
              ? { 'data-testid': `rich-select-${props.stateKey}-${option.value}` } : { testID: `rich-select-${props.stateKey}-${option.value}` })}
            className={`rounded-md px-4 ${disabled || option.disabled ? 'opacity-40' : ''}`}
            style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: TOUCH }}>
            <SelectPrimitive.ItemText className="text-foreground text-body" />
            <SelectPrimitive.ItemIndicator><Icon as={Check} className="text-foreground size-4" /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectContent>
      </Select>
      {selected ? <SurfacePressable accessibilityRole="button" accessibilityLabel={t('{label}：清空选择', { label })}
        testID={`rich-select-${props.stateKey}-clear`} disabled={disabled}
        onPress={() => set(pointerForKey(props.stateKey), '')} className="absolute top-0 items-center justify-center rounded-full"
        style={{ right: SELECT_CLEAR_RIGHT, width: TOUCH, height: TOUCH }}>
        <Icon as={X} size={16} className="text-muted-foreground" />
      </SurfacePressable> : null}
    </View>
  </View>;
}

type SegmentedProps = z.infer<typeof componentSchemas.Segmented>;
/** The 3px track padding belongs to no option: a 42 visual block + 3 above and below = 48 target (design §3.4, F14). */
const SEGMENT_TRACK_PADDING = 3;
const SEGMENT_ITEM_HEIGHT = TOUCH - SEGMENT_TRACK_PADDING * 2;
const SEGMENT_HIT_SLOP = { top: SEGMENT_TRACK_PADDING, bottom: SEGMENT_TRACK_PADDING };
/** Same look as foundation Tabs text-segment (track + selected block, caption text); the track is muted inside the card. */
export function SegmentedField({ props }: { props: SegmentedProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="Segmented" label={label} stateKey={props.stateKey} options={props.options} />;
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{label}</FieldLabel>
    <ToggleGroup type="single" value={String(state[props.stateKey] || '') || undefined} onValueChange={(value) => set(pointerForKey(props.stateKey), value || '')}
      disabled={disabled} className="bg-muted w-full rounded-lg" style={{ minHeight: TOUCH, padding: SEGMENT_TRACK_PADDING }}>
      {props.options.map((option, index) => {
        const selected = state[props.stateKey] === option.value;
        return <ToggleGroupItem key={option.value} value={option.value} disabled={disabled} hitSlop={SEGMENT_HIT_SLOP}
          isFirst={index === 0} isLast={index === props.options.length - 1} testID={`rich-segment-${props.stateKey}-${option.value}`}
          accessibilityLabel={`${label}：${option.label}`}
          style={{ minHeight: SEGMENT_ITEM_HEIGHT }}
          className={`h-auto flex-1 rounded-md px-1 shadow-none ${selected ? 'bg-card dark:bg-secondary' : 'bg-background/0'}`}>
          <UIText variant="caption" pointerEvents="none" className={`text-center ${selected ? 'text-foreground' : 'text-muted-foreground'}`} numberOfLines={2}>{option.label}</UIText>
        </ToggleGroupItem>;
      })}
    </ToggleGroup></View>;
}

type MultipleProps = z.infer<typeof componentSchemas.MultiSelect>;
export function MultiSelectField({ props }: { props: MultipleProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const values = state[props.stateKey] as string[];
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="MultiSelect" label={label} stateKey={props.stateKey} options={props.options} />;
  const toggle = (value: string) => set(pointerForKey(props.stateKey), values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  // Chips: primary = selected, soft = not selected (design §3.6); checked state is announced, not only drawn.
  if (props.variant !== 'checklist') return <View style={{ gap: richSpace.sm }}><FieldLabel>{label}</FieldLabel>
    <View className="flex-row flex-wrap" style={{ gap: richSpace.sm }}>
      {props.options.map((option) => {
        const checked = values.includes(option.value);
        return <Button key={option.value} intent={checked ? 'primary' : 'soft'} size="sm" disabled={disabled} onPress={() => toggle(option.value)}
          role="checkbox" accessibilityState={{ checked, disabled }} accessibilityLabel={`${label}：${option.label}`}
          testID={`rich-multi-${props.stateKey}-${option.value}`} className="max-w-full">
          <UIText className="min-w-0">{option.label}</UIText>
        </Button>;
      })}
    </View></View>;
  // Checklist: the whole row is the checkbox (≥48); the foundation box is only its visual.
  return <View style={{ gap: richSpace.xs }}><FieldLabel>{label}</FieldLabel>
    <View className={disabled ? 'opacity-50' : undefined}>{props.options.map((option, index) => {
      const checked = values.includes(option.value);
      return <SurfacePressable key={`${option.value}-${index}`} onPress={() => toggle(option.value)} disabled={disabled}
        role="checkbox" accessibilityState={{ checked, disabled }} accessibilityLabel={`${label}：${option.label}`}
        testID={`rich-multi-${props.stateKey}-${option.value}`}
        className={`flex-row items-center ${index ? 'border-border/50 border-t' : ''}`}
        style={{ minHeight: TOUCH, gap: richSpace.md, paddingVertical: richSpace.sm }}>
        <View pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Checkbox checked={checked} onCheckedChange={() => {}} />
        </View>
        <View className="min-w-0 flex-1">
          <RichText pointerEvents="none" className="text-foreground" style={richType.body}>{option.label}</RichText>
          {option.note ? <Caption>{option.note}</Caption> : null}
        </View>
      </SurfacePressable>;
    })}</View></View>;
}

type SwitchProps = z.infer<typeof componentSchemas.Switch>;
export function SwitchField({ props }: { props: SwitchProps }) {
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const insideField = useContext(RichFieldContext);
  if (submitted) return <SelectedField type="Switch" label={props.label} stateKey={props.stateKey} />;
  return <View className="flex-row items-center justify-between" style={{ minHeight: TOUCH, gap: richSpace.md }}>
    {!insideField ? <RichText className="text-foreground min-w-0 flex-1" style={richType.body}>{props.label}</RichText> : null}
    <SwitchUI checked={Boolean(state[props.stateKey])} onCheckedChange={(checked) => set(pointerForKey(props.stateKey), checked)}
      disabled={disabled} accessibilityLabel={props.label} testID={`rich-switch-${props.stateKey}`} />
  </View>;
}

type SliderProps = z.infer<typeof componentSchemas.Slider>;
/** Android's native slider insets its track by ~12 on each side; offset it so the track lines up with the label. */
const ANDROID_SLIDER_INSET = 12;
/** Field layout: caption label left, current value right. In chat the drawer must not take a horizontal drag (F2). */
export function SliderField({ props }: { props: SliderProps }) {
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const insideField = useContext(RichFieldContext);
  const [foreground, track] = useCSSVariable(['--color-foreground', '--color-border']).map((color) => color === undefined ? undefined : String(color));
  const value = Number(state[props.stateKey]);
  if (submitted) return <SelectedField type="Slider" label={props.label} stateKey={props.stateKey} />;
  return <View style={{ gap: richSpace.xs }}>
    {!insideField ? <View className="flex-row items-baseline justify-between" style={{ gap: richSpace.md }}>
      <View className="min-w-0 flex-1"><FieldLabel>{props.label}</FieldLabel></View>
      <RichText className="text-foreground" style={[richType.body, { fontWeight: '600', fontVariant: ['tabular-nums'] }]}>{String(value)}</RichText>
    </View> : null}
    <DrawerNativeControlGesture>
      <SliderControl value={value} minimumValue={props.min} maximumValue={props.max} step={props.step}
        onValueChange={(next) => set(pointerForKey(props.stateKey), alignedSliderValue(props.min, props.max, props.step, next))} disabled={disabled || props.min === props.max}
        minimumTrackTintColor={foreground} maximumTrackTintColor={track} thumbTintColor={foreground}
        accessibilityLabel={props.label} testID={`rich-slider-${props.stateKey}`}
        style={{ height: TOUCH, marginHorizontal: Platform.OS === 'android' ? -ANDROID_SLIDER_INSET : 0 }} />
    </DrawerNativeControlGesture>
  </View>;
}

type TextInputProps = z.infer<typeof componentSchemas.TextInput>;
/** Single and multi-line share the filled field (muted inside the card); no outlined Textarea. */
export function TextInputField({ props }: { props: TextInputProps }) {
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  if (submitted) return <SelectedField type="TextInput" label={props.label} stateKey={props.stateKey} />;
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{props.label}</FieldLabel>
    <Input tone="muted" value={String(state[props.stateKey] ?? '')} onChangeText={(next) => set(pointerForKey(props.stateKey), next)}
      editable={!disabled} maxLength={2000} placeholder={props.placeholder} accessibilityLabel={props.label} testID={`rich-input-${props.stateKey}`}
      {...(props.multiline ? { multiline: true, textAlignVertical: 'top' as const, className: 'min-h-24 py-3' } : {})} /></View>;
}

type DateInputProps = z.infer<typeof componentSchemas.DateInput>;
export function DateInputField({ props }: { props: DateInputProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const [shown, setShown] = useState(false);
  const raw = String(state[props.stateKey] || '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const update = (next: Date) => set(pointerForKey(props.stateKey), `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`);
  if (submitted) return <SelectedField type="DateInput" label={props.label} stateKey={props.stateKey} />;
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{props.label}</FieldLabel>
    <SurfacePressable onPress={() => {
      if (Platform.OS === 'android') DateTimePickerAndroid.open({ value: date, mode: 'date', onValueChange: (_, next) => update(next) });
      else setShown(true);
    }} disabled={disabled} accessibilityRole="button" accessibilityLabel={props.label} accessibilityValue={raw ? { text: raw } : undefined}
      testID={`rich-date-${props.stateKey}`}
      className={`bg-muted min-h-12 flex-row items-center rounded-[12px] px-4 ${disabled ? 'opacity-50' : ''}`} style={{ gap: richSpace.sm }}>
      <Icon as={CalendarDays} size={16} className="text-muted-foreground" />
      <UIText variant="body" className={raw ? 'text-foreground' : 'text-muted-foreground'}>{raw || t('选择日期')}</UIText>
    </SurfacePressable>
    {shown && Platform.OS !== 'android' ? <DateTimePicker value={date} mode="date" display="spinner" onValueChange={(_, next) => { update(next); setShown(false); }} onDismiss={() => setShown(false)} /> : null}
  </View>;
}

type SubmitProps = z.infer<typeof componentSchemas.Submit>;
export function SubmitField({ props, elementId }: { props: SubmitProps; elementId?: string }) {
  const { t } = useTranslation();
  const { submitted, submitDisabled, pending, submit, submittedAt } = useContext(RichInteractionContext);
  const interaction = useContext(RichInteractionContext);
  if (props.send) {
    if (submitted) return <UIText style={richType.body}>{props.label}</UIText>;
    return <Button intent="primary" disabled={submitDisabled} onPress={() => interaction.send!(elementId!)}
      testID="rich-send" accessibilityLabel={props.label} className="w-full">
      <UIText>{pending ? t('正在发送…') : props.label}</UIText>
    </Button>;
  }
  if (submitted) return <View className="flex-row items-center" style={{ gap: richSpace.sm }}>
    <Icon as={Check} size={14} className="text-muted-foreground" /><Caption>{t('已提交 · {time}', { time: submittedAt || '' })}</Caption></View>;
  return <Button intent="primary" disabled={submitDisabled} onPress={submit} testID="rich-submit" accessibilityLabel={props.label} className="w-full">
    <UIText>{pending ? t('提交中…') : props.label}</UIText>
  </Button>;
}

/** Feedback below the form, inside the frame: waiting for the persisted receipt, or a red reason + soft retry (chat.E4). */
export function SubmitFeedback({ completed, error, pending, onRetry, sending = false, onCheck, checking = false }: {
  completed: boolean; error: { message: string; retryable: boolean } | null; pending: boolean; onRetry: () => void; sending?: boolean;
  onCheck?: () => void; checking?: boolean;
}) {
  const { t } = useTranslation();
  if (error) return <View style={{ gap: richSpace.sm }} testID="rich-submit-error">
    <Caption className="text-destructive">{t(error.message)}</Caption>
    {error.retryable ? <Button intent="soft" size="sm" onPress={onRetry} disabled={pending} accessibilityLabel={sending ? t('重试') : t('重试提交')}
      testID="rich-submit-retry" className="self-start"><UIText>{sending ? t('重试') : t('重试提交')}</UIText></Button> : null}
    {onCheck ? <Button intent="soft" size="sm" onPress={onCheck} disabled={pending || checking}
      accessibilityLabel={checking ? t('核对中…') : t('核对结果')} className="self-start">
      <UIText>{checking ? t('核对中…') : t('核对结果')}</UIText></Button> : null}
  </View>;
  return completed ? <Caption>{sending ? t('已发送，等待对话更新…') : t('已提交，等待对话更新…')}</Caption> : null;
}
