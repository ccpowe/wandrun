import { useCallback, useContext, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { LineChart, PieChart } from 'react-native-gifted-charts';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { useCSSVariable } from 'uniwind';
import { useTranslation } from '../../lib/i18n.ts';
import { barLabelSlots, barRectangle, chartSelection, groupedBars, toggleChartSelection } from '../../lib/rich-chart.ts';
import { RichText as Text } from './math.tsx';
import { componentSchemas } from './spec.ts';
import { chartValueAxis } from './chart-values.ts';
import { chartViewportProps, chartYAxisLabelWidth, lineLayout, LINE_POINT_RADIUS } from './chart-viewport.ts';
import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { RichFramedContext } from './framed-context.ts';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';
import type { z } from 'zod';

type LineProps = z.infer<typeof componentSchemas.LineChart>;
type BarProps = z.infer<typeof componentSchemas.BarChart>;
type PieProps = z.infer<typeof componentSchemas.PieChart>;
type Series = LineProps['series'];
type LineStyle = { shape: 'circular' | 'rectangular'; dash?: number[] };
const lineStyles: LineStyle[] = [
  { shape: 'circular' }, { shape: 'rectangular', dash: [8, 4] }, { shape: 'circular', dash: [2, 4] },
];

function useChartColors() {
  const framed = useContext(RichFramedContext);
  const [text, border, background, card, ...series] = useCSSVariable([
    '--color-muted-foreground', '--color-border', '--color-background', '--color-card',
    '--color-chart-1', '--color-chart-2', '--color-chart-3',
    '--color-chart-4', '--color-chart-5', '--color-chart-6',
  ]);
  return { series: series.map(String), border: String(border), background: String(framed ? card : background), text: String(text) };
}

function ChartHeading({ title, unit }: { title?: string; unit?: string }) {
  return title || unit ? <View style={{ gap: richSpace.xs }}>
    {title ? <Text style={richType.title}>{title}</Text> : null}
    {unit ? <Text className="text-muted-foreground" style={richType.subtle}>{unit}</Text> : null}
  </View> : null;
}

function Legend({ entries }: { entries: { name: string; color: string; lineStyle?: LineStyle; value?: string }[] }) {
  const { fontScale } = useWindowDimensions();
  return <View className="flex-row items-center" style={{ gap: richSpace.sm, height: richType.title.lineHeight * fontScale }}>{entries.map((entry, index) =>
    <View key={index} className="min-w-0 flex-1 flex-row items-center" style={{ gap: richSpace.xs }}>
      {entry.lineStyle ? <Svg width={24} height={14} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Line x1={1} x2={23} y1={7} y2={7} stroke={entry.color} strokeWidth={2} strokeDasharray={entry.lineStyle.dash} />
        {entry.lineStyle.shape === 'rectangular' ? <Rect x={9} y={4} width={6} height={6} fill={entry.color} />
          : <Circle cx={12} cy={7} r={3} fill={entry.color} />}
      </Svg> : <View style={{ width: 10, height: 10, borderRadius: richRadius.full, backgroundColor: entry.color }} />}
      {entry.value === undefined ? <Text numberOfLines={1} className="flex-1 text-muted-foreground" style={richType.subtle}>{entry.name}</Text>
        : <Text numberOfLines={1} style={{ ...richType.title, flexShrink: 1, maxWidth: '100%' }}>{entry.value}</Text>}
    </View>)}</View>;
}

/** Selection replaces the legend within one fixed row, without moving the message. */
function Readout({ labels, series, selected, colors, line = false, unit }: {
  labels: string[]; series: Series; selected: number | null; colors: string[]; line?: boolean; unit?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const entries = series.map((item, index) => ({ name: item.name, value: selected === null ? undefined : String(item.values[selected]),
    color: colors[index], lineStyle: line ? lineStyles[index] : undefined }));
  return <View testID="rich-chart-readout" accessible accessibilityLiveRegion="polite"
    accessibilityLabel={selected === null ? series.map((item) => item.name).join('；')
      : `${labels[selected]} · ${series.map((item) => `${item.name}：${item.values[selected]}${unit ? ` ${unit}` : ''}`).join('；')}`}
    style={{ height: richType.title.lineHeight * fontScale }}>
    {selected !== null ? <View className="flex-row items-center" style={{ gap: richSpace.sm }}>
      <Text numberOfLines={1} className="text-muted-foreground" style={{ ...richType.subtle, maxWidth: '28%' }}>{labels[selected]}</Text>
      <View className="min-w-0 flex-1"><Legend entries={entries} /></View>
    </View> : <Legend entries={entries} />}
  </View>;
}

/** One native text per cell: read-screen navigation never depends on SVG marks. */
function ChartData({ labels, series, kind, unit }: { labels: string[]; series: Series; kind: 'line' | 'bar' | 'pie'; unit?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!labels.length) return null;
  return <>
    <Pressable testID={`rich-${kind}-points-toggle`} accessibilityRole="button"
      accessibilityLabel={t('查看图表数据')} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)} className="self-end items-center justify-center"
      style={{ minHeight: richGeometry.touch, minWidth: richGeometry.touch }}>
      <Text className="text-muted-foreground" style={richType.subtle}>{open ? t('收起') : t('数据')}</Text>
    </Pressable>
    {open ? <View testID={`rich-${kind}-data-table`}>
      <View className="flex-row border-b border-border/50" style={{ paddingVertical: richSpace.sm }}>
        {[t('类别'), ...series.map((item) => item.name)].map((label, index) =>
          <Text key={index} accessibilityRole="header" className="flex-1 text-muted-foreground"
            style={{ ...richType.subtle, paddingHorizontal: richSpace.xs }}>{label}</Text>)}
      </View>
      {labels.map((label, index) => <View key={index} className="flex-row border-b border-border/50" style={{ paddingVertical: richSpace.sm }}>
        <Text className="flex-1" style={{ ...richType.subtle, paddingHorizontal: richSpace.xs }}>{label}</Text>
        {series.map((item, column) => <Text key={column} className="flex-1" selectable
          accessibilityLabel={`${label} · ${item.name}：${item.values[index]}${unit ? ` ${unit}` : ''}`}
          style={{ ...richType.subtle, paddingHorizontal: richSpace.xs }}>{String(item.values[index])}</Text>)}
      </View>)}
    </View> : null}
  </>;
}

function EmptyChart() {
  const { t } = useTranslation();
  return <View testID="rich-chart-empty" className="justify-center" style={{ minHeight: richGeometry.chartHeight }}>
    <Text className="text-muted-foreground" style={richType.subtle}>{t('暂无数据')}</Text>
  </View>;
}

function ZeroChart({ color }: { color: string }) {
  const { t } = useTranslation();
  return <View style={{ gap: richSpace.sm }}>
    <View testID="rich-chart-zero-baseline" className="justify-center" style={{ height: richGeometry.chartHeight }}>
      <Text className="text-muted-foreground" style={richType.subtle}>0</Text>
      <View style={{ height: 1, backgroundColor: color }} />
    </View>
    <Text className="text-muted-foreground" style={richType.subtle}>{t('本期都是 0')}</Text>
  </View>;
}

/** Gifted draws; RNGH selects categories without its JS responder stealing vertical chat scrolling. */
export function RichLineChart({ props }: { props: LineProps }) {
  const colors = useChartColors();
  const [containerWidth, setContainerWidth] = useState(0);
  const [selection, setSelection] = useState<number | null>(null);
  const selected = selection !== null && props.xLabels.length ? Math.min(selection, props.xLabels.length - 1) : null;
  const all = props.series.flatMap((series) => series.values);
  const empty = all.length === 0;
  const zero = !empty && all.every((value) => value === 0);
  const axis = chartValueAxis(all);
  const { fontScale } = useWindowDimensions();
  const sections = axis.above + axis.below;
  const viewport = chartViewportProps(containerWidth, 'line', chartYAxisLabelWidth(axis.labels, fontScale));
  const layout = lineLayout(viewport.width, props.xLabels, fontScale);
  const categoryAt = useCallback((x: number) => chartSelection(x,
    viewport.yAxisLabelWidth + 1 + layout.initialSpacing, layout.spacing, props.xLabels.length),
  [viewport.yAxisLabelWidth, layout.initialSpacing, layout.spacing, props.xLabels.length]);
  const onDrag = useCallback((x: number) => setSelection(categoryAt(x)), [categoryAt]);
  const onTap = useCallback((x: number) => setSelection((current) => toggleChartSelection(current, categoryAt(x))), [categoryAt]);
  const dataSet = props.series.map((series, index) => ({
    color: colors.series[index], thickness: 2, strokeDashArray: lineStyles[index].dash,
    dataPointsShape: lineStyles[index].shape, dataPointsColor: colors.series[index], dataPointsRadius: LINE_POINT_RADIUS,
    dataPointsWidth: 2 * LINE_POINT_RADIUS, dataPointsHeight: 2 * LINE_POINT_RADIUS,
    data: series.values.map((value, i) => ({ value: axis.values[index * props.xLabels.length + i] + axis.below * 25,
      dataPointRadius: i === selected ? 5 : LINE_POINT_RADIUS,
      dataPointWidth: i === selected ? 10 : 2 * LINE_POINT_RADIUS, dataPointHeight: i === selected ? 10 : 2 * LINE_POINT_RADIUS,
      showVerticalLine: index === 0 && i === selected, verticalLineColor: colors.text, verticalLineThickness: 1 })),
  }));
  return <View style={{ flexGrow: 1, gap: richSpace.sm }} testID="rich-line-chart"
    onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
    <ChartHeading title={props.title} unit={props.unit} />
    {!empty ? <Readout labels={props.xLabels} series={props.series} selected={selected} colors={colors.series} line unit={props.unit} /> : null}
    {empty ? <EmptyChart /> : zero ? <ZeroChart color={colors.border} /> : containerWidth > 0 ?
      <DrawerHorizontalGesture onDrag={onDrag} onTap={onTap}><View collapsable={false} testID="rich-line-plot"
        style={{ paddingTop: richGeometry.chartHeight / sections / 2 }}>
        <LineChart dataSet={dataSet} height={richGeometry.chartHeight} {...viewport}
          initialSpacing={layout.initialSpacing} endSpacing={layout.endSpacing} spacing={layout.spacing} disableScroll
          maxValue={sections * 25} noOfSections={sections} stepValue={25}
          rulesLength={viewport.width} xAxisLength={viewport.width}
          stepHeight={richGeometry.chartHeight / sections} noOfSectionsBelowXAxis={0}
          yAxisLabelTexts={axis.labels} yAxisTextStyle={{ color: colors.text, ...richType.subtle }}
          xAxisLabelsHeight={0} xAxisColor={colors.border} yAxisColor={colors.border} rulesColor={colors.border}
          backgroundColor={colors.background} isAnimated={false} />
        <View style={{ marginLeft: viewport.yAxisLabelWidth + 1, flexDirection: 'row', alignItems: 'flex-start' }}>
          {layout.ticks.map((tick, index) => <Text key={tick.index} testID={`rich-line-label-${tick.index}`}
            style={{ marginLeft: tick.left - (index ? layout.ticks[index - 1].left + layout.labelWidth : 0),
              width: layout.labelWidth, flexShrink: 0, textAlign: 'center', ...richType.subtle }}
            className="text-muted-foreground">{tick.label}</Text>)}
        </View>
      </View></DrawerHorizontalGesture> : null}
    <ChartData kind="line" labels={props.xLabels} series={props.series} unit={props.unit} />
  </View>;
}

export function RichBarChart({ props }: { props: BarProps }) {
  const colors = useChartColors();
  const [containerWidth, setContainerWidth] = useState(0);
  const [selection, setSelection] = useState<number | null>(null);
  const selected = selection !== null && props.labels.length ? Math.min(selection, props.labels.length - 1) : null;
  const all = props.series.flatMap((series) => series.values);
  const empty = all.length === 0;
  const zero = !empty && all.every((value) => value === 0);
  const axis = chartValueAxis(all);
  const { fontScale } = useWindowDimensions();
  const horizontal = props.horizontal === true;
  const labelSize = chartYAxisLabelWidth(horizontal ? props.labels : axis.labels, fontScale);
  const viewport = chartViewportProps(containerWidth, 'bar', labelSize);
  const categoryExtent = horizontal ? Math.max(richGeometry.chartHeight, props.labels.length * richGeometry.touch * fontScale) : viewport.width;
  const layout = groupedBars(categoryExtent, props.labels.length, props.series.length);
  const slot = layout.slot;
  const labelWidth = viewport.yAxisLabelWidth;
  const count = props.labels.length;
  const categoryAt = useCallback((x: number, y: number) => chartSelection(horizontal ? y - richSpace.md : x - labelWidth,
    slot / 2, slot, count), [horizontal, labelWidth, slot, count]);
  const onDrag = useCallback((x: number, y: number) => setSelection(categoryAt(x, y)), [categoryAt]);
  const onTap = useCallback((x: number, y: number) => setSelection((current) => toggleChartSelection(current, categoryAt(x, y))), [categoryAt]);
  const bands = axis.above + axis.below;
  const plotHeight = horizontal ? categoryExtent : richGeometry.chartHeight;
  const valueExtent = horizontal ? viewport.width : plotHeight;
  const baseline = valueExtent * (horizontal ? axis.below : axis.above) / bands;
  const tickLayout = lineLayout(viewport.width, axis.labels, fontScale);
  const categoryLayout = lineLayout(viewport.width, props.labels, fontScale);
  const categoryTicks = barLabelSlots(count, viewport.width, categoryLayout.labelWidth, richSpace.sm);
  return <View style={{ gap: richSpace.sm }} testID="rich-bar-chart" onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
    <ChartHeading title={props.title} unit={props.unit} />
    {!empty ? <Readout labels={props.labels} series={props.series} selected={selected} colors={colors.series} unit={props.unit} /> : null}
    {empty ? <EmptyChart /> : zero ? <ZeroChart color={colors.border} /> : containerWidth > 0 ?
      <DrawerHorizontalGesture onDrag={onDrag} onTap={onTap} vertical={horizontal}><View collapsable={false} testID="rich-bar-plot"
        style={{ paddingVertical: richSpace.md }}>
        <View className="flex-row">
          <View style={{ width: labelWidth, height: plotHeight }}>
            {horizontal ? props.labels.map((label, index) => <View key={index} className="justify-center"
              style={{ height: slot, paddingRight: richSpace.sm }}><Text className="text-muted-foreground" style={richType.subtle}>{label}</Text></View>)
              : axis.labels.map((label, index) => <Text key={index} className="text-muted-foreground"
                style={{ position: 'absolute', right: richSpace.sm, top: plotHeight - index * plotHeight / bands - richType.subtle.lineHeight * fontScale / 2,
                  ...richType.subtle }}>{label}</Text>)}
          </View>
          <Svg width={viewport.width} height={plotHeight} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {axis.labels.map((_, index) => horizontal
              ? <Line key={index} x1={index * viewport.width / bands} x2={index * viewport.width / bands} y1={0} y2={plotHeight}
                stroke={colors.border} strokeWidth={index === axis.below ? 2 : 1} />
              : <Line key={index} x1={0} x2={viewport.width} y1={plotHeight - index * plotHeight / bands} y2={plotHeight - index * plotHeight / bands}
                stroke={colors.border} strokeWidth={index === axis.below ? 2 : 1} />)}
            {props.labels.flatMap((label, category) => props.series.map((series, index) => <Rect key={`${category}-${index}`}
              {...barRectangle(axis.values[index * props.labels.length + category], baseline, valueExtent / (bands * 25),
                layout.initialSpacing + category * slot + index * (layout.barWidth + layout.innerGap), layout.barWidth, horizontal)}
              rx={richGeometry.chartBarRadius} fill={colors.series[index]} opacity={selected === null || category === selected ? 1 : 0.45} />))}
          </Svg>
        </View>
        {horizontal ? <View style={{ marginLeft: labelWidth, minHeight: richType.subtle.lineHeight * fontScale * 2 }}>
          {tickLayout.ticks.map((tick) => <Text key={tick.index} className="text-muted-foreground" style={{ position: 'absolute',
            left: Math.max(0, Math.min(viewport.width - tickLayout.labelWidth, tick.index * viewport.width / bands - tickLayout.labelWidth / 2)),
            width: tickLayout.labelWidth, textAlign: 'center', ...richType.subtle }}>{tick.label}</Text>)}
        </View> : <View style={{ marginLeft: labelWidth, flexDirection: 'row', paddingTop: richSpace.xs }}>
          {categoryTicks.map((tick, index) => <Text key={tick.index} className="text-muted-foreground"
            style={{ width: categoryLayout.labelWidth, flexShrink: 0,
              marginLeft: tick.left - (index ? categoryTicks[index - 1].left + categoryLayout.labelWidth : 0),
              textAlign: 'center', ...richType.subtle }}>{props.labels[tick.index]}</Text>)}
        </View>}
      </View></DrawerHorizontalGesture> : null}
    <ChartData kind="bar" labels={props.labels} series={props.series} unit={props.unit} />
  </View>;
}

export function RichPieChart({ props }: { props: PieProps }) {
  const colors = useChartColors();
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const [selected, setSelected] = useState<number | null>(null);
  // Divide before summing: legal positive ~1e308 values can overflow a raw total.
  const max = props.items.reduce((largest, item) => Math.max(largest, item.value), 0);
  const weights = props.items.map((item) => max ? item.value / max : 0);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const current = selected !== null ? props.items[selected] : undefined;
  return <View style={{ gap: richSpace.sm }} testID="rich-pie-chart">
    <View style={{ gap: richSpace.xs }}>
      <View testID="rich-pie-readout-slot" className="flex-row items-center" style={{ gap: richSpace.sm, height: richType.title.lineHeight * fontScale }}>
        {props.title ? <Text numberOfLines={1} className="flex-1" style={richType.title}>{props.title}</Text> : null}
        {current ? <Text testID="rich-chart-readout" numberOfLines={1} className="flex-1" style={{ ...richType.title, textAlign: 'right' }} accessibilityLiveRegion="polite">
          {`${current.label}：${current.value}${props.unit ? ` ${props.unit}` : ''}`}</Text> : null}
      </View>
      {props.unit ? <Text className="text-muted-foreground" style={richType.subtle}>{props.unit}</Text> : null}
    </View>
    {!total ? <EmptyChart /> : <View className="items-center" testID="rich-pie-plot"><PieChart
      data={weights.map((value, index) => ({ value, color: colors.series[index], focused: selected === index,
        onPress: () => setSelected((current) => toggleChartSelection(current, index)) }))}
      radius={66} extraRadius={5} sectionAutoFocus strokeWidth={1} strokeColor={colors.background} isAnimated={false} /></View>}
    {props.items.length ? <View testID="rich-pie-legend">{props.items.map((item, index) => <Pressable key={index}
      testID={`rich-pie-point-${index}`} accessibilityRole="button" accessibilityState={{ selected: selected === index }}
      accessibilityLabel={`${item.label}：${item.value}${props.unit ? ` ${props.unit}` : ''}`}
      onPress={() => setSelected((current) => toggleChartSelection(current, index))} className={`flex-row items-center${index ? ' border-border/50 border-t' : ''}`}
      style={{ gap: richSpace.sm, minHeight: richGeometry.touch, paddingVertical: richSpace.xs }}>
      <View style={{ width: 10, height: 10, borderRadius: richRadius.full, backgroundColor: colors.series[index] }} />
      <Text numberOfLines={1} className="flex-1" style={{ ...richType.subtle, fontWeight: selected === index ? '600' : '400' }}>{item.label}</Text>
      <Text numberOfLines={1} className="text-muted-foreground" style={{ ...richType.subtle, flexShrink: 1, maxWidth: '60%' }}>{`${total ? Number(((weights[index] / total) * 100).toPrecision(3)) : 0}% · ${item.value}`}</Text>
    </Pressable>)}</View> : null}
    <ChartData kind="pie" labels={props.items.map((item) => item.label)}
      series={[{ name: t('数值'), values: props.items.map((item) => item.value) }]} unit={props.unit} />
  </View>;
}
