import { Children, createContext, useContext, useId, useState } from 'react';
import { Linking, Pressable, ScrollView, View, Platform, useWindowDimensions } from 'react-native';
import type { MediaLocation, ImageItem } from './media.tsx';
import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { MediaCard, MediaGallery, MediaPicture } from './media.tsx';
import { MermaidPicture } from './mermaid.tsx';
import SliderControl from '@react-native-community/slider';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { defineCatalog } from '@json-render/core';
import { defineRegistry, useStateStore } from '@json-render/react-native';
import { schema } from '@json-render/react-native/schema';
import * as SelectPrimitive from '@rn-primitives/select';
import { useCSSVariable } from 'uniwind';
import { CalendarDays, Check, ChevronDown, ChevronUp, Info, CircleCheck, TriangleAlert, CircleAlert, X } from 'lucide-react-native';
import type { GatewayApi } from '@/gateway/api.ts';
import { useTranslation } from '../../lib/i18n.ts';
import { sourceSite } from './source-site.ts';
import { z } from 'zod';

import { Badge as BadgeUI } from '@/components/ui/badge.tsx';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card as CardUI } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Progress as ProgressUI } from '@/components/ui/progress.tsx';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Select, SelectContent, SelectTrigger } from '@/components/ui/select.tsx';
import { Switch as SwitchUI } from '@/components/ui/switch.tsx';
import { Text as UIText } from '@/components/ui/text.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { richIcons } from './icons.tsx';
import { FileTreeDisplay } from './file-tree.tsx';
import { LinkCardDisplay, groupLinks } from './link-card.tsx';
import { RichMath, RichText } from './math.tsx';
import { useRichColors, type RichTone } from './semantic-colors.ts';
import { RichBarChart, RichLineChart, RichPieChart } from './charts.tsx';
import { alignedSliderValue, componentSchemas, displayFieldValue, pointerForKey } from './spec.ts';
import { metricColumns, readableColumns } from './layout.ts';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';

type MediaOwner = { files?: Readonly<Record<string, string>>; api?: GatewayApi;
  conversationId?: string; messageSeq?: number; block?: number };
function fileFor(owner: MediaOwner, item: ImageItem): string | undefined {
  return item.attachment && owner.files && Object.hasOwn(owner.files, item.attachment) ? owner.files[item.attachment] : undefined;
}
function locationFor(owner: MediaOwner, element: string, index: number, enabled: boolean): MediaLocation | undefined {
  if (!enabled || owner.conversationId === undefined || owner.messageSeq === undefined || owner.block === undefined) return undefined;
  return { conversationId: owner.conversationId, messageSeq: owner.messageSeq, block: owner.block, element, index };
}

const leaf: string[] = [];
const container = ['children'];
export const richCatalog = defineCatalog(schema, {
  components: {
    Stack: { props: componentSchemas.Stack, slots: container, description: '排列内容' },
    Card: { props: componentSchemas.Card, slots: container, description: '卡片' },
    Divider: { props: componentSchemas.Divider, slots: leaf, description: '分隔线' },
    Heading: { props: componentSchemas.Heading, slots: leaf, description: '标题' },
    Text: { props: componentSchemas.Text, slots: leaf, description: '说明文字' },
    Badge: { props: componentSchemas.Badge, slots: leaf, description: '状态标记' },
    Status: { props: componentSchemas.Status, slots: leaf, description: '状态摘要' },
    Metrics: { props: componentSchemas.Metrics, slots: leaf, description: '指标' },
    KeyValue: { props: componentSchemas.KeyValue, slots: leaf, description: '键值' },
    Steps: { props: componentSchemas.Steps, slots: leaf, description: '步骤' },
    Progress: { props: componentSchemas.Progress, slots: leaf, description: '进度' },
    Table: { props: componentSchemas.Table, slots: leaf, description: '表格' },
    ChoiceGroup: { props: componentSchemas.ChoiceGroup, slots: leaf, description: '单选' },
    Select: { props: componentSchemas.Select, slots: leaf, description: '下拉单选' },
    Segmented: { props: componentSchemas.Segmented, slots: leaf, description: '分段单选' },
    MultiSelect: { props: componentSchemas.MultiSelect, slots: leaf, description: '多选' },
    Switch: { props: componentSchemas.Switch, slots: leaf, description: '开关' },
    Slider: { props: componentSchemas.Slider, slots: leaf, description: '滑块' },
    TextInput: { props: componentSchemas.TextInput, slots: leaf, description: '文本输入' },
    DateInput: { props: componentSchemas.DateInput, slots: leaf, description: '日期' },
    Submit: { props: componentSchemas.Submit, slots: leaf, description: '提交' },
    LineChart: { props: componentSchemas.LineChart, slots: leaf, description: '折线趋势' },
    BarChart: { props: componentSchemas.BarChart, slots: leaf, description: '柱状比较' },
    PieChart: { props: componentSchemas.PieChart, slots: leaf, description: '占比与图例' },
    Tabs: { props: componentSchemas.Tabs, slots: container, description: '本地切换的选项卡' },
    Accordion: { props: componentSchemas.Accordion, slots: container, description: '本地展开的详情' },
    Grid: { props: componentSchemas.Grid, slots: container, description: '响应式等宽网格' },
    Source: { props: componentSchemas.Source, slots: leaf, description: '可展开横滑的网页来源卡片' },
    LinkCard: { props: componentSchemas.LinkCard, slots: leaf, description: '网页链接列表项' },
    FileTree: { props: componentSchemas.FileTree, slots: leaf, description: '目录结构' },
    Icon: { props: componentSchemas.Icon, slots: leaf, description: '受控图标' },
    List: { props: componentSchemas.List, slots: leaf, description: '有序或无序列表' },
    Callout: { props: componentSchemas.Callout, slots: leaf, description: '语义提示' },
    Quote: { props: componentSchemas.Quote, slots: leaf, description: '引用' },
    Math: { props: componentSchemas.Math, slots: leaf, description: 'LaTeX 公式' },
    Image: { props: componentSchemas.Image, slots: leaf, description: '附件或代理图片' },
    MediaCard: { props: componentSchemas.MediaCard, slots: leaf, description: '图文卡片' },
    Gallery: { props: componentSchemas.Gallery, slots: leaf, description: '横滑图片组' },
    Mermaid: { props: componentSchemas.Mermaid, slots: leaf, description: '流程图' },
  },
  actions: {},
});

type Interaction = { submitted: boolean; disabled: boolean; pending: boolean; submit: () => void; submittedAt: string | null };
export const RichInteractionContext = createContext<Interaction>({ submitted: false, disabled: false, pending: false, submit: () => {}, submittedAt: null });
export const RichImageContext = createContext<MediaOwner>({});
const InsideRichCard = createContext(false);

function CardDisplay({ props, children }: { props: z.infer<typeof componentSchemas.Card>; children?: React.ReactNode }) {
  const nested = useContext(InsideRichCard);
  return <CardUI className="border-border py-0 shadow-none"
    style={{ gap: richSpace.lg, borderRadius: nested ? richRadius.medium : richRadius.large,
      paddingTop: richSpace.lg, paddingRight: richSpace.lg, paddingBottom: richSpace.lg, paddingLeft: richSpace.lg }}>
    {props.title ? <RichText style={richType.title}>{props.title}</RichText> : null}
    <InsideRichCard.Provider value={true}>{groupLinks(children)}</InsideRichCard.Provider>
  </CardUI>;
}

const Subtle = ({ children }: { children: React.ReactNode }) => <RichText className="text-muted-foreground" style={richType.subtle}>{children}</RichText>;
const Body = ({ children, inline = false }: { children: React.ReactNode; inline?: boolean }) => <RichText inline={inline} className="text-foreground" style={richType.body}>{children}</RichText>;
type TableCell = string | { badge: { text: string; tone?: RichTone } };
/** Rows inside a horizontal ScrollView have no definite width, so flex ratios size each row by its own
 * content. Measure the card once and give every column the same explicit width; scroll when it does not fit. */
function RichTable({ columns, rows }: { columns: string[]; rows: TableCell[][] }) {
  const [available, setAvailable] = useState(0);
  const width = Math.max(80, available / columns.length);
  const cell = { width, paddingRight: richSpace.xs } as const;
  return <View onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 ? <DrawerHorizontalGesture><ScrollView horizontal showsHorizontalScrollIndicator={false}><View>
      <View className="flex-row">{columns.map((column, i) => <View key={i} style={cell}><Subtle>{column}</Subtle></View>)}</View>
      {rows.map((row, i) => <View key={i} className="border-border flex-row items-start border-t" style={{ paddingVertical: richSpace.sm }}>{row.map((value, j) => <View key={j} style={cell}>
        {typeof value === 'string' ? <Body>{value}</Body> : <View className="self-start"><StatusBadge {...value.badge} /></View>}
      </View>)}</View>)}
    </View></ScrollView></DrawerHorizontalGesture> : null}
  </View>;
}
function StatusBadge({ text, tone = 'neutral' }: { text: string; tone?: RichTone }) {
  const palette = useRichColors();
  // Active retains stronger neutral text without restoring a solid inverted badge.
  const colors = tone === 'active'
    ? { foreground: palette.active.border, background: palette.neutral.background }
    : palette[tone];
  return <BadgeUI variant="secondary" style={{ backgroundColor: colors.background, borderWidth: 0, gap: richSpace.xs, borderRadius: richRadius.full, paddingHorizontal: richSpace.sm, paddingVertical: richSpace.xs }}>
    <RichText style={[richType.subtle, { color: colors.foreground, fontWeight: richType.title.fontWeight }]}>{text}</RichText>
  </BadgeUI>;
}
function ProgressMeter({ value, caption }: { value: number; caption?: string }) {
  return <View style={{ gap: richSpace.sm }}><ProgressUI value={value} className="bg-muted" style={{ height: richGeometry.progressHeight, borderRadius: richRadius.full }} indicatorClassName="bg-foreground" />
    {caption ? <Subtle>{caption}</Subtle> : null}</View>;
}
function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return <View className="bg-muted" style={{ gap: richSpace.xs, borderRadius: richRadius.medium, paddingHorizontal: richSpace.md, paddingVertical: richSpace.sm }}><Subtle>{label}</Subtle><Body>{value}</Body></View>;
}
function SelectedField({ stateKey, label, type, options }: { stateKey: string; label: string; type: 'ChoiceGroup' | 'Select' | 'Segmented' | 'MultiSelect' | 'Switch' | 'Slider' | 'TextInput' | 'DateInput'; options?: { value: string; label: string }[] }) {
  const { state } = useStateStore();
  const value = displayFieldValue(type, options, state[stateKey]);
  return <ReadOnlyValue label={label} value={value} />;
}
function FieldLabel({ children }: { children: string }) {
  return <RichText className="text-muted-foreground" style={richType.subtle}>{children}</RichText>;
}

type ChoiceProps = z.infer<typeof componentSchemas.ChoiceGroup>;
function ChoiceGroupField({ props }: { props: ChoiceProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="ChoiceGroup" label={label} stateKey={props.stateKey} options={props.options} />;
  const compact = props.options.every(option => !option.description && !option.tags?.length);
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{label}</FieldLabel>
    <RadioGroup value={String(state[props.stateKey] ?? '')} style={{ gap: compact ? richSpace.xs : richSpace.md }} onValueChange={(value) => {
      if (!disabled && props.options.some((option) => option.value === value && !option.disabled)) set(pointerForKey(props.stateKey), value);
    }}>
      {props.options.map((option) => {
        const selected = state[props.stateKey] === option.value;
        return <Pressable key={option.value} onPress={() => !disabled && !option.disabled && set(pointerForKey(props.stateKey), option.value)}
          disabled={disabled || option.disabled} accessibilityRole="radio" accessibilityLabel={`${label}：${option.label}`}
          accessibilityState={{ checked: selected, disabled: disabled || !!option.disabled }} testID={`rich-choice-${props.stateKey}-${option.value}`}
          className={`flex-row ${compact ? 'items-center' : `items-start border ${selected ? 'border-foreground' : 'border-border'}`} ${option.disabled ? 'opacity-50' : ''}`}
          style={{ minHeight: richGeometry.touch, gap: richSpace.md, ...(compact ? { paddingVertical: richSpace.sm } : { borderRadius: richRadius.medium, padding: richSpace.md }) }}>
          <RadioGroupItem value={option.value} disabled={disabled || option.disabled} className="border-muted-foreground"
            style={{ width: richGeometry.radioSize, height: richGeometry.radioSize, marginTop: compact ? 0 : richSpace.xs, borderRadius: richRadius.full }} />
          <View className="flex-1" style={{ gap: richSpace.xs }}><RichText pointerEvents="none" style={[richType.body, selected && { fontWeight: richType.title.fontWeight }]}>{option.label}</RichText>
            {option.tags?.length ? <View className="flex-row flex-wrap" style={{ gap: richSpace.xs }}>{option.tags.map((tag) => <BadgeUI key={tag} variant="secondary" className="border-transparent" style={{ gap: richSpace.xs, borderRadius: richRadius.full, paddingHorizontal: richSpace.sm, paddingVertical: richSpace.xs }}><RichText style={richType.subtle}>{tag}</RichText></BadgeUI>)}</View> : null}
            {option.description ? <Subtle>{option.description}</Subtle> : null}</View>
        </Pressable>;
      })}
    </RadioGroup></View>;
}

type SelectProps = z.infer<typeof componentSchemas.Select>;
function SelectField({ props }: { props: SelectProps }) {
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
          <SelectTrigger disabled={disabled} accessibilityLabel={label} testID={`rich-select-${props.stateKey}`}
            style={{ minHeight: richGeometry.touch, paddingHorizontal: richSpace.md, borderRadius: richRadius.medium }}>
            <RichText pointerEvents="none" className="text-foreground min-w-0 flex-1"
              style={[richType.body, { paddingRight: selected ? richGeometry.touch : richSpace.sm }]}>{selected?.label || t('请选择')}</RichText>
          </SelectTrigger>
          <SelectContent sideOffset={richSpace.xs} style={{ borderRadius: richRadius.medium, padding: richSpace.xs }}>
            {props.options.map((option) => <SelectPrimitive.Item key={option.value} value={option.value} label={option.label}
              disabled={disabled || option.disabled} {...(Platform.OS === 'web'
                ? { 'data-testid': `rich-select-${props.stateKey}-${option.value}` } : { testID: `rich-select-${props.stateKey}-${option.value}` })}
              className={disabled || option.disabled ? 'opacity-40' : undefined}
              style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                minHeight: richGeometry.touch, borderRadius: richRadius.small,
                paddingTop: richSpace.sm, paddingRight: richSpace.md, paddingBottom: richSpace.sm, paddingLeft: richSpace.md }}>
              <SelectPrimitive.ItemText className="text-foreground" style={richType.body} />
              <SelectPrimitive.ItemIndicator><Icon as={Check} className="text-foreground size-4" /></SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>)}
          </SelectContent>
        </Select>
      {/* Sibling overlay stays inside the trigger visually, without nesting interactive buttons. */}
      {selected ? <Pressable accessibilityRole="button" accessibilityLabel={t('{label}：清空选择', { label })}
        testID={`rich-select-${props.stateKey}-clear`} disabled={disabled}
        onPress={() => set(pointerForKey(props.stateKey), '')} className="absolute top-0 items-center justify-center"
        style={{ right: richSpace.lg + richSpace.md, width: richGeometry.touch, height: richGeometry.touch }}>
        <Icon as={X} size={16} className="text-muted-foreground" />
      </Pressable> : null}
    </View>
  </View>;
}

type SegmentedProps = z.infer<typeof componentSchemas.Segmented>;
function SegmentedField({ props }: { props: SegmentedProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="Segmented" label={label} stateKey={props.stateKey} options={props.options} />;
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{label}</FieldLabel>
    <ToggleGroup type="single" value={String(state[props.stateKey] || '') || undefined} onValueChange={(value) => set(pointerForKey(props.stateKey), value || '')}
      disabled={disabled} className="bg-muted w-full" style={{ borderRadius: richRadius.medium, padding: richSpace.xs }}>
      {props.options.map((option, index) => <ToggleGroupItem key={option.value} value={option.value} disabled={disabled}
        isFirst={index === 0} isLast={index === props.options.length - 1} testID={`rich-segment-${props.stateKey}-${option.value}`}
        accessibilityLabel={`${label}：${option.label}`} className={`flex-1 shadow-none ${state[props.stateKey] === option.value ? 'bg-background' : 'bg-transparent'}`}
        style={{ minHeight: richGeometry.touch, borderRadius: richRadius.small, paddingHorizontal: richSpace.xs }}>
        <RichText pointerEvents="none" className="text-center" style={[richType.body, state[props.stateKey] === option.value && { fontWeight: richType.title.fontWeight }]} numberOfLines={2}>{option.label}</RichText>
      </ToggleGroupItem>)}
    </ToggleGroup></View>;
}

type MultipleProps = z.infer<typeof componentSchemas.MultiSelect>;
function MultiSelectField({ props }: { props: MultipleProps }) {
  const { t } = useTranslation();
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const values = state[props.stateKey] as string[];
  const label = props.label || t('选择');
  if (submitted) return <SelectedField type="MultiSelect" label={label} stateKey={props.stateKey} options={props.options} />;
  if (props.variant !== 'checklist') return <View style={{ gap: richSpace.sm }}><FieldLabel>{label}</FieldLabel>
    <ToggleGroup type="multiple" value={values} onValueChange={(next) => set(pointerForKey(props.stateKey), next)} disabled={disabled} className="w-full flex-wrap" style={{ gap: richSpace.sm }}>
      {props.options.map((option) => <ToggleGroupItem key={option.value} value={option.value} disabled={disabled}
        accessibilityLabel={`${label}：${option.label}`} testID={`rich-multi-${props.stateKey}-${option.value}`}
        className={`h-auto w-auto flex-none whitespace-normal border ${values.includes(option.value) ? 'border-foreground' : 'border-border'}`}
        style={{ flexGrow: 0, flexShrink: 0, flexBasis: 'auto', alignSelf: 'flex-start', width: 'auto', height: 'auto', maxWidth: '100%',
          minHeight: richGeometry.touch, borderRadius: richRadius.full, paddingHorizontal: richSpace.md, paddingVertical: richSpace.sm }}>
        <RichText pointerEvents="none" className="min-w-0" style={richType.body}>{option.label}</RichText></ToggleGroupItem>)}
    </ToggleGroup></View>;
  return <View style={{ gap: richSpace.xs }}><FieldLabel>{label}</FieldLabel>{props.options.map((option, index) => {
    const checked = values.includes(option.value);
    const toggle = () => set(pointerForKey(props.stateKey), checked ? values.filter((v) => v !== option.value) : [...values, option.value]);
    return <View key={`${option.value}-${index}`} className={`flex-row items-center ${index ? 'border-border border-t' : ''}`}
      style={{ minHeight: richGeometry.touch, gap: richSpace.md, paddingVertical: richSpace.sm }}>
      <Checkbox checked={checked} onCheckedChange={toggle} disabled={disabled} accessibilityLabel={`${label}：${option.label}`}
        testID={`rich-multi-${props.stateKey}-${option.value}`} style={{ width: richGeometry.radioSize, height: richGeometry.radioSize, borderRadius: richRadius.small }} />
      <Pressable onPress={toggle} disabled={disabled} accessibilityLabel={`${label}：${option.label}`} className="min-w-0 flex-1 justify-center"
        style={{ minHeight: richGeometry.touch }}>
        <Body>{option.label}</Body>{option.note ? <Subtle>{option.note}</Subtle> : null}
      </Pressable>
    </View>;
  })}</View>;
}

type SwitchProps = z.infer<typeof componentSchemas.Switch>;
function SwitchField({ props }: { props: SwitchProps }) {
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  if (submitted) return <SelectedField type="Switch" label={props.label} stateKey={props.stateKey} />;
  return <View className="flex-row items-center justify-between" style={{ minHeight: richGeometry.touch, gap: richSpace.md }}><Body>{props.label}</Body>
    <SwitchUI checked={Boolean(state[props.stateKey])} onCheckedChange={(checked) => set(pointerForKey(props.stateKey), checked)}
      disabled={disabled} accessibilityLabel={props.label} testID={`rich-switch-${props.stateKey}`} style={{ height: richGeometry.switchHeight, width: richGeometry.touch, borderRadius: richRadius.full }} />
  </View>;
}

type SliderProps = z.infer<typeof componentSchemas.Slider>;
function SliderField({ props }: { props: SliderProps }) {
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  const [foreground, muted] = useCSSVariable(['--color-foreground', '--color-muted']);
  const value = Number(state[props.stateKey]);
  if (submitted) return <SelectedField type="Slider" label={props.label} stateKey={props.stateKey} />;
  return <View style={{ gap: richSpace.xs }}><View className="flex-row justify-between"><FieldLabel>{props.label}</FieldLabel><Subtle>{String(value)}</Subtle></View>
    <SliderControl value={value} minimumValue={props.min} maximumValue={props.max} step={props.step}
      onValueChange={(next) => set(pointerForKey(props.stateKey), alignedSliderValue(props.min, props.max, props.step, next))} disabled={disabled || props.min === props.max}
      minimumTrackTintColor={String(foreground ?? '#141414')} maximumTrackTintColor={String(muted ?? '#F0F0ED')}
      thumbTintColor={String(foreground ?? '#141414')} accessibilityLabel={props.label} testID={`rich-slider-${props.stateKey}`} />
  </View>;
}

type TextInputProps = z.infer<typeof componentSchemas.TextInput>;
function TextInputField({ props }: { props: TextInputProps }) {
  const { state, set } = useStateStore();
  const { submitted, disabled } = useContext(RichInteractionContext);
  if (submitted) return <SelectedField type="TextInput" label={props.label} stateKey={props.stateKey} />;
  const Component = props.multiline ? Textarea : Input;
  return <View style={{ gap: richSpace.sm }}><FieldLabel>{props.label}</FieldLabel><Component value={String(state[props.stateKey] ?? '')}
    onChangeText={(next) => set(pointerForKey(props.stateKey), next)} editable={!disabled} maxLength={2000}
    placeholder={props.placeholder} accessibilityLabel={props.label} testID={`rich-input-${props.stateKey}`}
    style={[richType.body, { minHeight: props.multiline ? richGeometry.touch + richSpace.xl : richGeometry.touch,
      paddingHorizontal: richSpace.md, paddingVertical: richSpace.xs, borderRadius: richRadius.medium }]} /></View>;
}

type DateInputProps = z.infer<typeof componentSchemas.DateInput>;
function DateInputField({ props }: { props: DateInputProps }) {
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
    <Pressable onPress={() => {
      if (Platform.OS === 'android') DateTimePickerAndroid.open({ value: date, mode: 'date', onValueChange: (_, next) => update(next) });
      else setShown(true);
    }} disabled={disabled} accessibilityRole="button" accessibilityLabel={props.label} testID={`rich-date-${props.stateKey}`}
      className="border-border flex-row items-center border"
      style={{ minHeight: richGeometry.touch, gap: richSpace.sm, borderRadius: richRadius.medium, paddingHorizontal: richSpace.md }}>
      <Icon as={CalendarDays} className="text-muted-foreground size-4" /><Body>{raw || t('选择日期')}</Body></Pressable>
    {shown && Platform.OS !== 'android' ? <DateTimePicker value={date} mode="date" display="spinner" onValueChange={(_, next) => { update(next); setShown(false); }} onDismiss={() => setShown(false)} /> : null}
  </View>;
}

function TabsDisplay({ props, children }: { props: z.infer<typeof componentSchemas.Tabs>; children?: React.ReactNode }) {
  const [active, setActive] = useState('0');
  const id = useId();
  const panels = Children.toArray(children);
  const scrollable = props.tabs.length > 4;
  // The transparent 44px trigger owns touch/accessibility; only its compact inner pill is painted.
  const tabList = <TabsList className={`bg-transparent mr-0 p-0 ${scrollable ? 'w-auto' : 'w-full'}`}
    style={{ height: richGeometry.touch, gap: richSpace.xs }}>
    {props.tabs.map((tab, index) => <TabsTrigger key={index} value={String(index)}
      nativeID={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
      accessibilityLabel={tab.label} testID={`rich-tab-${index}`}
      className="border-0 bg-transparent dark:bg-transparent dark:border-transparent p-0 shadow-none"
      style={{ height: richGeometry.touch, minHeight: richGeometry.touch, flexGrow: scrollable ? 0 : 1,
        flexBasis: scrollable ? 'auto' : 0, flexShrink: 0, minWidth: 0 }}>
      <View pointerEvents="none" className={active === String(index) ? 'bg-muted' : 'bg-transparent'}
        style={{ flexGrow: scrollable ? 0 : 1, width: scrollable ? undefined : '100%', minWidth: 0,
          alignItems: 'center', borderRadius: richRadius.full,
          paddingHorizontal: richSpace.md, paddingVertical: richSpace.xs }}>
        <RichText numberOfLines={1} className={active === String(index) ? 'text-foreground' : 'text-muted-foreground'}
          style={{ ...richType.subtle, maxWidth: scrollable ? undefined : '100%',
            fontWeight: active === String(index) ? richType.title.fontWeight : richType.subtle.fontWeight }}>
          {tab.label}
        </RichText>
      </View>
    </TabsTrigger>)}
  </TabsList>;
  return <Tabs value={active} onValueChange={setActive} style={{ gap: richSpace.md }}>
    {scrollable ? <DrawerHorizontalGesture><ScrollView horizontal showsHorizontalScrollIndicator={false}>{tabList}</ScrollView></DrawerHorizontalGesture> : tabList}
    {/* Primitive web Content drops forceMount; stable panels preserve nested local state on both platforms. */}
    {panels.map((panel, index) => <View key={index} role="tabpanel"
      nativeID={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`}
      style={{ display: active === String(index) ? 'flex' : 'none' }}
      accessibilityElementsHidden={active !== String(index)}
      importantForAccessibility={active === String(index) ? 'auto' : 'no-hide-descendants'}>
      {panel}
    </View>)}
  </Tabs>;
}

function AccordionDisplay({ props, children }: { props: z.infer<typeof componentSchemas.Accordion>; children?: React.ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return <Accordion type="single" value={open ? 'content' : ''}
    onValueChange={(value: string | undefined) => setOpen(value === 'content')} collapsible>
    <AccordionItem value="content" className="border-border border" style={{ borderRadius: richRadius.medium, paddingHorizontal: richSpace.md }}>
      <AccordionTrigger accessibilityLabel={props.title} testID="rich-accordion-toggle"
        className="items-center gap-0 py-0"
        style={{ minHeight: richGeometry.touch, borderRadius: richRadius.small }}>
        <View style={{ paddingVertical: richSpace.sm, marginRight: richSpace.lg, flexShrink: 1 }}><RichText pointerEvents="none" style={richType.title}>{props.title}</RichText></View>
      </AccordionTrigger>
      <AccordionContent forceMount className="pb-0" style={{ display: open ? 'flex' : 'none' }}
        accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
        <View style={{ paddingBottom: richSpace.lg }}>{groupLinks(children)}</View>
      </AccordionContent>
    </AccordionItem>
  </Accordion>;
}

function ImageDisplay({ props, elementId }: { props: z.infer<typeof componentSchemas.Image>; elementId: string }) {
  const owner = useContext(RichImageContext);
  return <View className="border-border border bg-card" style={{ gap: richSpace.sm, borderRadius: richRadius.medium, padding: richSpace.sm }} testID="rich-image-card">
    <MediaPicture api={owner.api} location={locationFor(owner, elementId, 0, 'url' in props || !!fileFor(owner, props))}
      fileId={fileFor(owner, props)} alt={props.alt} />
    {props.caption ? <Subtle>{props.caption}</Subtle> : null}
  </View>;
}

function GridDisplay({ props, children }: { props: z.infer<typeof componentSchemas.Grid>; children?: React.ReactNode }) {
  const [available, setAvailable] = useState(0);
  const { fontScale } = useWindowDimensions();
  const minimum = (props as typeof props & { __minimumWidth?: number }).__minimumWidth ?? 96;
  const { width } = readableColumns(available, props.columns, minimum, fontScale);
  // Reserve a pixel before flex growth: a measured fractional width can round down in Yoga.
  // A single wrapping parent keeps each cell's React ancestry unchanged when columns change.
  const basis = Math.max(0, Math.floor(width) - 1);
  const cells = Children.toArray(groupLinks(children));
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: richSpace.sm }}
    onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 && cells.map((cell, index) =>
      <View key={index} style={{ flexGrow: 1, flexShrink: 0, flexBasis: basis, minWidth: 0, maxWidth: width }}>{cell}</View>)}
  </View>;
}
function MetricsDisplay({ props }: { props: z.infer<typeof componentSchemas.Metrics> }) {
  const [available, setAvailable] = useState(0);
  const { fontScale } = useWindowDimensions();
  const { columns } = metricColumns(available, props.items.length, fontScale);
  // Explicit rows avoid fractional fixed widths wrapping early in Yoga. Flex distributes
  // the remaining pixels and also fills the last row without leaving a half-width item.
  return <View style={{ width: '100%', gap: richSpace.sm }}
    onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 && Array.from({ length: Math.ceil(props.items.length / columns) }, (_, row) =>
      <View key={row} style={{ flexDirection: 'row', gap: richSpace.sm }}>
        {props.items.slice(row * columns, (row + 1) * columns).map((item, index) =>
          <View key={index} style={{ flex: 1, minWidth: 0, gap: richSpace.xs, borderRadius: richRadius.medium, padding: richSpace.md }} className="bg-muted">
            <RichText style={richType.metric}>{item.value}</RichText>
            <Subtle>{item.label}</Subtle>{item.hint ? <Subtle>{item.hint}</Subtle> : null}
          </View>)}
      </View>)}
  </View>;
}


function SourceDisplay({ props }: { props: z.infer<typeof componentSchemas.Source> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const sources = props.items.map(source => {
    const host = new URL(source.url).hostname;
    return { ...source, host, site: sourceSite(host) };
  });
  const sites = [...new Map(sources.map(({ site }) => [site.site, site])).values()].slice(0, 3);
  const multiple = sources.length > 1;
  return <View style={{ gap: richSpace.sm, minWidth: 0 }}>
    {multiple ? <Pressable testID="rich-source-toggle" accessibilityRole="button"
      accessibilityState={{ expanded }} aria-expanded={expanded} accessibilityLabel={t('来源，{count} 条', { count: sources.length })}
      onPress={() => setExpanded(!expanded)} className="bg-muted flex-row items-center self-start"
      style={{ minHeight: richGeometry.touch, maxWidth: '100%', borderRadius: richRadius.full,
        gap: richSpace.sm, paddingHorizontal: richSpace.md, paddingVertical: richSpace.xs }}>
      <View pointerEvents="none" className="flex-row" accessible={false} aria-hidden accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        {sites.map((site, index) => <View key={site.site} className="items-center justify-center border-muted"
          style={{ width: richGeometry.sourceMarkSize, height: richGeometry.sourceMarkSize,
            borderRadius: richRadius.full, borderWidth: richGeometry.sourceMarkBorder,
            marginLeft: index ? -richGeometry.sourceMarkOverlap : 0, backgroundColor: site.color }}>
          <UIText allowFontScaling={false} style={richType.caption} className="text-white">{site.letter}</UIText>
        </View>)}
      </View>
      <UIText style={richType.subtle} className="text-muted-foreground">{t('来源 · {count}', { count: sources.length })}</UIText>
      <Icon as={expanded ? ChevronUp : ChevronDown} className="text-muted-foreground size-4" />
    </Pressable> : null}
    {!multiple || expanded ? <DrawerHorizontalGesture><ScrollView horizontal directionalLockEnabled showsHorizontalScrollIndicator={false}
      testID="rich-source-rail" contentContainerStyle={{ gap: richSpace.sm }}
      style={{ flexGrow: 0, ...(Platform.OS === 'web' ? { touchAction: 'pan-x' as const, overscrollBehaviorX: 'contain' as const } : {}) }}>
      {sources.map((source, index) => <Pressable key={`${source.url}-${index}`} testID={`rich-source-${index}`}
        accessibilityRole="link"
        accessibilityLabel={t('来源 {index}，{title}，{url}', { index: index + 1, title: source.title || source.host, url: source.url })}
        onPress={() => void Linking.openURL(source.url)} className="bg-muted"
        style={{ width: richGeometry.sourceCardWidth, flexShrink: 0, minHeight: richGeometry.touch,
          borderRadius: richRadius.medium, gap: richSpace.xs, paddingHorizontal: richSpace.md, paddingVertical: richSpace.sm }}>
        <UIText numberOfLines={1} className="text-foreground"
          style={{ ...richType.subtle, fontWeight: richType.title.fontWeight }}>{source.title || source.host}</UIText>
        <View pointerEvents="none" className="flex-row items-center" style={{ gap: richSpace.xs }}>
          <View accessible={false} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            className="items-center justify-center"
            style={{ width: richGeometry.sourceCardMarkSize, height: richGeometry.sourceCardMarkSize,
              flexShrink: 0, borderRadius: richRadius.full, backgroundColor: source.site.color }}>
            <UIText allowFontScaling={false} className="text-white" style={richType.caption}>{source.site.letter}</UIText>
          </View>
          {/* Strip only www.; the accessible label and open action keep the full original destination. */}
          <UIText numberOfLines={1} className="text-muted-foreground" style={{ ...richType.caption, flexShrink: 1 }}>{source.host.replace(/^www\./, '')}</UIText>
        </View>
      </Pressable>)}
    </ScrollView></DrawerHorizontalGesture> : null}
  </View>;
}


function ListDisplay({ props }: { props: z.infer<typeof componentSchemas.List> }) {
  return <View style={{ gap: richSpace.sm }}>{props.items.map((item, index) => <View key={index} className="flex-row items-start" style={{ gap: richSpace.sm }}>
    <View className="items-center" style={{ width: richSpace.xl, paddingTop: richSpace.xs }}>
      {props.ordered || !item.icon ? <RichText className="text-muted-foreground" style={richType.body}>{props.ordered ? `${index + 1}.` : '•'}</RichText> :
        <Icon as={richIcons[item.icon as keyof typeof richIcons]} className="text-muted-foreground size-4" />}
    </View>
    {props.ordered && item.icon ? <Icon as={richIcons[item.icon as keyof typeof richIcons]} className="text-muted-foreground size-4" /> : null}
    <View className="min-w-0 flex-1"><Body inline>{item.text}</Body></View>
  </View>)}</View>;
}

function CalloutDisplay({ props }: { props: z.infer<typeof componentSchemas.Callout> }) {
  const colors = useRichColors()[props.tone];
  const symbol = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert }[props.tone];
  return <View className="flex-row items-start border"
    style={{ gap: richSpace.sm, borderRadius: richRadius.medium, padding: richSpace.md, backgroundColor: colors.background, borderColor: colors.border }}>
    <Icon as={symbol} size={17} color={colors.foreground} />
    <View className="min-w-0 flex-1" style={{ gap: richSpace.xs }}>
      {props.title ? <RichText style={[richType.title, { color: colors.foreground }]}>{props.title}</RichText> : null}
      <RichText inline style={[richType.body, { color: colors.foreground }]}>{props.text}</RichText>
    </View>
  </View>;
}

function QuoteDisplay({ props }: { props: z.infer<typeof componentSchemas.Quote> }) {
  return <View className="border-border border-l-2" style={{ gap: richSpace.sm, paddingVertical: richSpace.xs, paddingLeft: richSpace.md }}>
    <Body inline>{props.text}</Body>
    {props.attribution ? <Subtle>{`— ${props.attribution}`}</Subtle> : null}
  </View>;
}

function MediaCardNode({ props, elementId }: { props: z.infer<typeof componentSchemas.MediaCard>; elementId: string }) {
  const owner = useContext(RichImageContext);
  return <MediaCard item={props} title={props.title} description={props.description} tags={props.tags}
    direction={props.direction} api={owner.api} location={locationFor(owner, elementId, 0, 'url' in props || !!fileFor(owner, props))}
    fileId={fileFor(owner, props)} />;
}

function GalleryNode({ props, elementId }: { props: z.infer<typeof componentSchemas.Gallery>; elementId: string }) {
  const owner = useContext(RichImageContext);
  return <MediaGallery items={props.items} api={owner.api}
    locate={(index) => locationFor(owner, elementId, index, 'url' in props.items[index] || !!fileFor(owner, props.items[index]))}
    fileFor={(item) => fileFor(owner, item)} />;
}

function MermaidNode({ props, elementId }: { props: z.infer<typeof componentSchemas.Mermaid>; elementId: string }) {
  const owner = useContext(RichImageContext);
  return <MermaidPicture source={props.source} title={props.title} location={locationFor(owner, elementId, 0, true)} />;
}

export const { registry: richRegistry } = defineRegistry(richCatalog, {
  components: {
    Stack: ({ props, children }) => <View className={`${props.direction === 'horizontal' ? `flex-row flex-wrap items-center ${props.justify === 'between' ? 'justify-between' : ''}` : 'flex-col'}`}
      style={{ gap: props.gap === 'sm' ? richSpace.sm : richSpace.md }}>{groupLinks(children)}</View>,
    Card: CardDisplay,
    Divider: () => <Separator style={{ marginVertical: richSpace.xs }} />,
    Heading: ({ props }) => <RichText style={richType.heading}>{props.text}</RichText>,
    Text: ({ props }) => <RichText inline className={props.tone === 'muted' ? 'text-muted-foreground' : undefined}
      style={props.tone === 'muted' ? richType.subtle : richType.body}>{props.text}</RichText>,
    Badge: ({ props }) => <View className="self-start"><StatusBadge text={props.text} tone={props.tone} /></View>,
    Status: ({ props }) => <View style={{ gap: richSpace.md }}><View className="flex-row items-center justify-between" style={{ gap: richSpace.sm }}><RichText style={richType.title}>{props.title}</RichText>{props.badge ? <StatusBadge {...props.badge} /> : null}</View>
      {props.progress !== undefined ? <ProgressMeter value={props.progress} /> : null}{props.caption ? <Subtle>{props.caption}</Subtle> : null}</View>,
    Metrics: MetricsDisplay,
    KeyValue: ({ props }) => <View>{props.items.map((item, index) => <View key={index} className={`flex-row items-start justify-between ${index ? 'border-border border-t' : ''}`}
      style={{ minHeight: richGeometry.touch, gap: richSpace.sm, paddingVertical: richSpace.xs }}>
      <RichText className="text-muted-foreground flex-1" style={richType.body}>{item.label}</RichText><RichText className="flex-1 text-right" style={richType.body}>{item.value}</RichText></View>)}</View>,
    Steps: ({ props }) => {
      const { t } = useTranslation();
      const states = { done: '已完成', current: '进行中', todo: '未开始', failed: '失败' } as const;
      return <View>{props.items.map((item, index) => {
        const last = index === props.items.length - 1;
        return <View key={index} accessible
          accessibilityLabel={t('第 {number} 步，{label}，{status}', { number: index + 1, label: item.label, status: t(states[item.state]) })}
          accessibilityHint={item.note}
          className="flex-row items-start" style={{ gap: richSpace.sm, paddingBottom: last ? 0 : richSpace.sm }}>
          <View className="self-stretch" style={{ flexShrink: 0, width: richSpace.xl }}>
            {/* The row includes its trailing space, so the rail meets the next circle even with wrapped notes. */}
            {!last ? <View testID="rich-step-connector" className={`absolute border-l ${item.state === 'done' ? 'border-foreground' : 'border-border'}`}
              style={{ left: '50%', top: richSpace.xl, bottom: -richSpace.sm }} /> : null}
            <View style={{ width: richSpace.xl, height: richSpace.xl, borderRadius: richRadius.full }}
              className={`items-center justify-center border ${item.state === 'failed' ? 'border-destructive' : item.state === 'done' || item.state === 'current' ? 'border-foreground bg-foreground' : 'border-muted-foreground'}`}>
              {item.state === 'done' ? <Icon as={Check} className="text-background size-3" />
                : <UIText className={item.state === 'failed' ? 'text-destructive' : item.state === 'current' ? 'text-background' : 'text-muted-foreground'}
                  style={richType.subtle}>{item.state === 'failed' ? '!' : index + 1}</UIText>}
            </View>
          </View>
          <View className="min-w-0 flex-1" style={{ gap: richSpace.xs }}>
            <RichText className={item.state === 'todo' ? 'text-muted-foreground' : 'text-foreground'}
              style={item.state === 'current' ? richType.title : richType.body}>{item.label}</RichText>
            {item.note ? <Subtle>{item.note}</Subtle> : null}
          </View>
        </View>;
      })}</View>;
    },
    Progress: ({ props }) => <ProgressMeter value={props.value} caption={props.caption} />,
    Table: ({ props }) => <RichTable columns={props.columns} rows={props.rows} />,
    LineChart: RichLineChart,
    BarChart: RichBarChart,
    PieChart: RichPieChart,
    Tabs: TabsDisplay,
    Accordion: AccordionDisplay,
    Grid: GridDisplay,
    Source: SourceDisplay,
    LinkCard: ({ props }) => {
      const owner = useContext(RichImageContext);
      return <LinkCardDisplay props={props} api={owner.api}
        location={locationFor(owner, (props as typeof props & { __mediaId: string }).__mediaId, 0, true)} />;
    },
    FileTree: FileTreeDisplay,
    Icon: ({ props }) => <View accessibilityLabel={props.label} accessible={!!props.label} className="self-start">
      <Icon as={richIcons[props.name as keyof typeof richIcons]} className="text-foreground"
        size={props.size === 'sm' ? 16 : props.size === 'lg' ? 24 : 20} />
    </View>,
    List: ListDisplay,
    Callout: CalloutDisplay,
    Quote: QuoteDisplay,
    Math: ({ props }) => <RichMath tex={props.tex} display={props.display} />,
    Image: ({ props }) => <ImageDisplay props={props} elementId={(props as typeof props & { __mediaId: string }).__mediaId} />,
    MediaCard: ({ props }) => <MediaCardNode props={props} elementId={(props as typeof props & { __mediaId: string }).__mediaId} />,
    Gallery: ({ props }) => <GalleryNode props={props} elementId={(props as typeof props & { __mediaId: string }).__mediaId} />,
    Mermaid: ({ props }) => <MermaidNode props={props} elementId={(props as typeof props & { __mediaId: string }).__mediaId} />,
    ChoiceGroup: ChoiceGroupField,
    Select: SelectField,
    Segmented: SegmentedField,
    MultiSelect: MultiSelectField,
    Switch: SwitchField,
    Slider: SliderField,
    TextInput: TextInputField,
    DateInput: DateInputField,
    Submit: ({ props }) => {
      const { t } = useTranslation();
      // Registry render functions are React components in json-render 0.21.0.
      const { submitted, disabled, pending, submit, submittedAt } = useContext(RichInteractionContext);
      if (submitted) return <View className="flex-row items-center" style={{ gap: richSpace.sm }}><Icon as={Check} className="text-muted-foreground size-4" /><Subtle>{t('已提交 · {time}', { time: submittedAt || '' })}</Subtle></View>;
      return <Button variant="outline" size="sm" disabled={disabled} onPress={submit} testID="rich-submit" accessibilityLabel={props.label}
        className="border-foreground w-full" style={{ minHeight: richGeometry.touch, borderRadius: richRadius.full, paddingHorizontal: richSpace.lg, gap: richSpace.sm }}><RichText pointerEvents="none" style={richType.title}>{pending ? t('提交中…') : props.label}</RichText></Button>;
    },
  },
});
