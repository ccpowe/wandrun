import { Children, createContext, useContext, useId, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useCSSVariable } from 'uniwind';
import { Check, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react-native';
import type { z } from 'zod';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion.tsx';
import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Progress as ProgressUI } from '@/components/ui/progress.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { Text as UIText } from '@/components/ui/text.tsx';
import { useTranslation } from '../../lib/i18n.ts';
import { richIcons } from './icons.tsx';
import { metricColumns } from './layout.ts';
import { RichFramedContext } from './framed-context.ts';
import { groupLinks } from './link-card.tsx';
import { RichText } from './math.tsx';
import { useRichColors, type RichTone } from './semantic-colors.ts';
import type { componentSchemas } from './spec.ts';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';

/**
 * Read-only rich components (ADR-0081 step 1a, `screens/rich-message.md` groups A–C, E).
 * A+ rule: read-only content has no surface or border and sits on the chat background;
 * only interactive blocks get the framed surface, which the form step owns.
 */

type Props<K extends keyof typeof componentSchemas> = { props: z.infer<(typeof componentSchemas)[K]> };

export const Subtle = ({ children }: { children: React.ReactNode }) =>
  <RichText className="text-muted-foreground" style={richType.subtle}>{children}</RichText>;
export const Body = ({ children, inline = false }: { children: React.ReactNode; inline?: boolean }) =>
  <RichText inline={inline} className="text-foreground" style={richType.body}>{children}</RichText>;

const InsideRichCard = createContext(false);

/** `RichCard.readonly`: a titled group, not a framed surface. */
export function CardDisplay({ props, children }: Props<'Card'> & { children?: React.ReactNode }) {
  const nested = useContext(InsideRichCard);
  return <View style={{ gap: nested ? richSpace.sm : richSpace.md }}>
    {props.title ? <RichText style={richType.title}>{props.title}</RichText> : null}
    <InsideRichCard.Provider value={true}>{groupLinks(children)}</InsideRichCard.Provider>
  </View>;
}

/** `Badge.<tone>`: tinted pill without border; active is distinguishable from neutral. */
export function StatusBadge({ text, tone = 'neutral' }: { text: string; tone?: RichTone }) {
  const palette = useRichColors();
  const semantic = tone !== 'neutral' && tone !== 'active';
  const className = tone === 'active' ? 'bg-foreground/10' : tone === 'neutral' ? 'bg-muted' : undefined;
  const textClass = tone === 'active' ? 'text-foreground' : tone === 'neutral' ? 'text-muted-foreground' : undefined;
  return <View className={`self-start ${className ?? ''}`}
    style={{ borderRadius: richRadius.full, paddingHorizontal: richSpace.sm, paddingVertical: 2,
      ...(semantic ? { backgroundColor: palette[tone].background } : {}) }}>
    <UIText className={textClass} style={[richType.subtle, { fontWeight: '500' }, semantic ? { color: palette[tone].foreground } : null]}>{text}</UIText>
  </View>;
}

/** `Callout.<tone>`: tinted background, no border; tone colors only the icon and title. */
export function CalloutDisplay({ props }: Props<'Callout'>) {
  const colors = useRichColors()[props.tone];
  const symbol = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert }[props.tone];
  return <View className="flex-row items-start"
    style={{ gap: richSpace.md, borderRadius: richRadius.medium, paddingHorizontal: richSpace.lg, paddingVertical: richSpace.md, backgroundColor: colors.background }}>
    {/* Center the 18px glyph on the first 26px body line. */}
    <View style={{ height: props.title ? richType.title.lineHeight : richType.body.lineHeight, justifyContent: 'center' }}>
      <Icon as={symbol} size={18} color={colors.foreground} />
    </View>
    <View className="min-w-0 flex-1" style={{ gap: 2 }}>
      {props.title ? <RichText style={[richType.title, { color: colors.foreground }]}>{props.title}</RichText> : null}
      <RichText inline className="text-foreground" style={richType.body}>{props.text}</RichText>
    </View>
  </View>;
}

export function QuoteDisplay({ props }: Props<'Quote'>) {
  return <View className="border-border border-l-2" style={{ gap: richSpace.xs, paddingLeft: richSpace.md }}>
    <Body inline>{props.text}</Body>
    {props.attribution ? <Subtle>{`— ${props.attribution}`}</Subtle> : null}
  </View>;
}

/** `List.default`: markers sit in a box one body line tall so they align with the first line. */
export function ListDisplay({ props }: Props<'List'>) {
  const line = richType.body.lineHeight;
  return <View style={{ gap: richSpace.xs }}>{props.items.map((item, index) => {
    const icon = item.icon ? richIcons[item.icon as keyof typeof richIcons] : undefined;
    return <View key={index} className="flex-row items-start" style={{ gap: richSpace.sm }}>
      <View className="items-center justify-center" style={{ minWidth: richSpace.lg, height: line }}>
        {props.ordered || !icon
          ? <RichText className="text-muted-foreground" style={richType.body}>{props.ordered ? `${index + 1}.` : '•'}</RichText>
          : <Icon as={icon} className="text-muted-foreground size-4" />}
      </View>
      {props.ordered && icon ? <View className="justify-center" style={{ height: line }}>
        <Icon as={icon} className="text-muted-foreground size-4" />
      </View> : null}
      <View className="min-w-0 flex-1"><Body inline>{item.text}</Body></View>
    </View>;
  })}</View>;
}

export const DividerDisplay = () => <Separator className="bg-border/50" style={{ marginVertical: richSpace.xs }} />;
export const HeadingDisplay = ({ props }: Props<'Heading'>) => <RichText style={richType.heading}>{String(props.text)}</RichText>;
export const TextDisplay = ({ props }: Props<'Text'>) => <RichText inline className={props.tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'}
  style={props.tone === 'muted' ? richType.subtle : richType.body}>{String(props.text)}</RichText>;
export const BadgeDisplay = ({ props }: Props<'Badge'>) => <StatusBadge text={props.text} tone={props.tone} />;
export const IconDisplay = ({ props }: Props<'Icon'>) => <View accessibilityLabel={props.label} accessible={!!props.label} className="self-start">
  <Icon as={richIcons[props.name as keyof typeof richIcons]} className="text-foreground"
    size={props.size === 'sm' ? 16 : props.size === 'lg' ? 24 : 20} />
</View>;

/** `Tabs.default`: foundation text-segment tabs; panels stay mounted to keep nested local state. */
export function TabsDisplay({ props, children }: Props<'Tabs'> & { children?: React.ReactNode }) {
  const [active, setActive] = useState('0');
  const id = useId();
  const panels = Children.toArray(children);
  // Up to four tabs share the track equally; five scroll horizontally at their natural width so long labels stay whole.
  const scrollable = props.tabs.length > 4;
  const list = <TabsList className={`bg-muted dark:bg-card ${scrollable ? 'w-auto' : ''}`}>
    {props.tabs.map((tab, index) => <TabsTrigger key={index} value={String(index)} className={scrollable ? 'flex-none px-4' : undefined}
      nativeID={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
      accessibilityLabel={tab.label} testID={`rich-tab-${index}`}>
      <UIText numberOfLines={1}>{tab.label}</UIText>
    </TabsTrigger>)}
  </TabsList>;
  // The foundation track is background/50 for card pages; on the chat background it needs a muted track.
  return <Tabs value={active} onValueChange={setActive} style={{ gap: richSpace.md }}>
    {scrollable ? <DrawerHorizontalGesture><ScrollView horizontal showsHorizontalScrollIndicator={false}>{list}</ScrollView></DrawerHorizontalGesture> : list}
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

/** `Accordion.collapsed` / `.expanded`: no frame; title row with the foundation chevron, ≥48 target. */
export function AccordionDisplay({ props, children }: Props<'Accordion'> & { children?: React.ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return <Accordion type="single" value={open ? 'content' : ''}
    onValueChange={(value: string | undefined) => setOpen(value === 'content')} collapsible>
    <AccordionItem value="content" className="border-b-0">
      <AccordionTrigger accessibilityLabel={props.title} testID="rich-accordion-toggle"
        className="items-center py-0" style={{ minHeight: richGeometry.touch }}>
        <View className="min-w-0 flex-1" style={{ paddingVertical: richSpace.sm }}>
          <RichText pointerEvents="none" style={richType.title}>{props.title}</RichText>
        </View>
      </AccordionTrigger>
      <AccordionContent forceMount className="pb-0" style={{ display: open ? 'flex' : 'none' }}
        accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
        <View style={{ paddingTop: richSpace.xs, paddingBottom: richSpace.sm, gap: richSpace.md }}>{groupLinks(children)}</View>
      </AccordionContent>
    </AccordionItem>
  </Accordion>;
}

/** `Progress.default`: thin foreground bar. */
export function ProgressMeter({ value, caption }: { value: number; caption?: string }) {
  return <View style={{ gap: richSpace.xs }}>
    <ProgressUI value={value} className="bg-muted" style={{ height: richGeometry.progressHeight, borderRadius: richRadius.full }} indicatorClassName="bg-foreground" />
    {caption ? <Subtle>{caption}</Subtle> : null}
  </View>;
}
export const ProgressDisplay = ({ props }: Props<'Progress'>) => <ProgressMeter value={props.value} caption={props.caption} />;

/** `Status.<state>`: title + badge + progress + caption; failure only through the badge and caption. */
export function StatusDisplay({ props }: Props<'Status'>) {
  return <View style={{ gap: richSpace.sm }}>
    <View className="flex-row items-center justify-between" style={{ gap: richSpace.sm }}>
      <RichText className="min-w-0 flex-1" style={richType.title}>{props.title}</RichText>
      {props.badge ? <StatusBadge {...props.badge} /> : null}
    </View>
    {props.progress !== undefined ? <ProgressMeter value={props.progress} /> : null}
    {props.caption ? <Subtle>{props.caption}</Subtle> : null}
  </View>;
}

/** `Metrics.default`: no surface; the hint is one step quieter than the label. */
export function MetricsDisplay({ props }: Props<'Metrics'>) {
  const [available, setAvailable] = useState(0);
  const { fontScale } = useWindowDimensions();
  const { columns } = metricColumns(available, props.items.length, fontScale);
  // Explicit rows avoid fractional fixed widths wrapping early in Yoga.
  return <View style={{ width: '100%', gap: richSpace.lg }} onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 && Array.from({ length: Math.ceil(props.items.length / columns) }, (_, row) =>
      <View key={row} style={{ flexDirection: 'row', gap: richSpace.lg }}>
        {props.items.slice(row * columns, (row + 1) * columns).map((item, index) =>
          <View key={index} style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <RichText style={richType.metric}>{item.value}</RichText>
            <Subtle>{item.label}</Subtle>
            {item.hint ? <RichText className="text-muted-foreground" style={richType.caption}>{item.hint}</RichText> : null}
          </View>)}
      </View>)}
  </View>;
}

/** `KeyValue.default`: flat rows with border/50 dividers; long values wrap. */
export function KeyValueDisplay({ props }: Props<'KeyValue'>) {
  return <View>{props.items.map((item, index) =>
    <View key={index} className={`flex-row items-start justify-between ${index ? 'border-border/50 border-t' : ''}`}
      style={{ minHeight: richGeometry.touch, gap: richSpace.md, paddingVertical: richSpace.sm }}>
      <RichText className="text-muted-foreground flex-1" style={richType.body}>{item.label}</RichText>
      <RichText className="flex-1 text-right" style={richType.body}>{String(item.value)}</RichText>
    </View>)}</View>;
}

const STEP_STATES = { done: '已完成', current: '进行中', todo: '未开始', failed: '失败' } as const;
/** `Steps.done` / `.current` / `.todo` / `.failed`: filled check, outlined number, quiet outline, red “!”. */
export function StepsDisplay({ props }: Props<'Steps'>) {
  const { t } = useTranslation();
  const circle = richSpace.xl;
  return <View>{props.items.map((item, index) => {
    const last = index === props.items.length - 1;
    const ring = item.state === 'done' ? 'border-foreground bg-foreground'
      : item.state === 'current' ? 'border-foreground border-2'
        : item.state === 'failed' ? 'border-destructive' : 'border-muted-foreground/60';
    return <View key={index} accessible
      accessibilityLabel={t('第 {number} 步，{label}，{status}', { number: index + 1, label: item.label, status: t(STEP_STATES[item.state]) })}
      accessibilityHint={item.note}
      className="flex-row items-start" style={{ gap: richSpace.md, paddingBottom: last ? 0 : richSpace.md }}>
      <View className="self-stretch items-center" style={{ flexShrink: 0, width: circle }}>
        {/* The row includes its trailing space, so the rail meets the next circle even with wrapped notes. */}
        {!last ? <View testID="rich-step-connector" className={`absolute ${item.state === 'done' ? 'bg-foreground' : 'bg-border'}`}
          style={{ width: 1, top: circle + 2, bottom: -richSpace.md + 2 }} /> : null}
        <View style={{ width: circle, height: circle, borderRadius: richRadius.full, marginTop: (richType.body.lineHeight - circle) / 2 }}
          className={`items-center justify-center ${item.state === 'current' ? '' : 'border'} ${ring}`}>
          {item.state === 'done' ? <Icon as={Check} className="text-background size-3.5" />
            : <UIText className={item.state === 'failed' ? 'text-destructive' : item.state === 'current' ? 'text-foreground' : 'text-muted-foreground'}
              style={[richType.caption, { fontWeight: item.state === 'current' ? '600' : '400' }]}>{item.state === 'failed' ? '!' : index + 1}</UIText>}
        </View>
      </View>
      <View className="min-w-0 flex-1" style={{ gap: richSpace.xs }}>
        <RichText className={item.state === 'todo' ? 'text-muted-foreground' : 'text-foreground'}
          style={[richType.body, item.state === 'current' ? { fontWeight: '500' } : null]}>{item.label}</RichText>
        {item.note ? <Subtle>{item.note}</Subtle> : null}
      </View>
    </View>;
  })}</View>;
}

type TableCell = string | { badge: { text: string; tone?: RichTone } };
/**
 * `Table.fits` / `.overflow`. Rows inside a horizontal ScrollView have no definite width, so every column
 * gets the same explicit width; when the table is wider than the block, a right-edge fade marks it scrollable
 * until the end is reached.
 */
export function TableDisplay({ props }: Props<'Table'>) {
  const [available, setAvailable] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  // The fade must end on the surface the table sits on: card inside a framed block, page background elsewhere.
  const background = String(useCSSVariable(useContext(RichFramedContext) ? '--color-card' : '--color-background'));
  const { columns, rows } = props as { columns: string[]; rows: TableCell[][] };
  const width = Math.max(80, available / columns.length);
  const overflow = width * columns.length > available + 1;
  const cell = { width, paddingRight: richSpace.sm } as const;
  return <View onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 ? <DrawerHorizontalGesture><ScrollView horizontal showsHorizontalScrollIndicator={false} scrollEventThrottle={32}
      onScroll={({ nativeEvent }) => setAtEnd(nativeEvent.contentOffset.x + nativeEvent.layoutMeasurement.width >= nativeEvent.contentSize.width - 2)}><View>
      <View className="border-border/60 flex-row border-b" style={{ paddingBottom: richSpace.sm }}>
        {columns.map((column, i) => <View key={i} style={cell}><Subtle>{column}</Subtle></View>)}
      </View>
      {rows.map((row, i) => <View key={i} className={`flex-row items-center ${i ? 'border-border/50 border-t' : ''}`}
        style={{ minHeight: richGeometry.touch, paddingVertical: richSpace.xs }}>{row.map((value, j) => <View key={j} style={cell}>
          {typeof value === 'string' ? <Body>{value}</Body> : <StatusBadge {...value.badge} />}
        </View>)}</View>)}
    </View></ScrollView></DrawerHorizontalGesture> : null}
    {overflow && !atEnd ? <LinearGradient pointerEvents="none" testID="rich-table-fade" colors={[`${background}00`, background]}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 32 }} /> : null}
  </View>;
}
