import { useContext, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { DrawerGestureContext } from 'react-native-drawer-layout';
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { useCSSVariable } from 'uniwind';
import { useTranslation } from '../../lib/i18n.ts';
import { RichText as Text } from './math.tsx';
import { componentSchemas } from './spec.ts';
import { chartValueAxis } from './chart-values.ts';
import { barLayout, chartViewportProps, chartYAxisLabelWidth, lineLayout, LINE_POINT_RADIUS } from './chart-viewport.ts';
import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';
import type { z } from 'zod';

type LineProps = z.infer<typeof componentSchemas.LineChart>;
type BarProps = z.infer<typeof componentSchemas.BarChart>;
type PieProps = z.infer<typeof componentSchemas.PieChart>;

type LineStyle = { shape: 'circular' | 'rectangular'; dash?: number[] };
const lineStyles: LineStyle[] = [
  { shape: 'circular' },
  { shape: 'rectangular', dash: [8, 4] },
  { shape: 'circular', dash: [2, 4] },
];
const fallbackSeries = ['#1D4ED8', '#0F766E', '#92400E', '#7C3AED', '#0E7490', '#475569'];

function useChartColors() {
  const [secondary, border, background, ...series] = useCSSVariable([
    '--color-muted-foreground', '--color-border', '--color-background',
    '--color-chart-1', '--color-chart-2', '--color-chart-3',
    '--color-chart-4', '--color-chart-5', '--color-chart-6',
  ]);
  return {
    series: series.map((value, index) => String(value ?? fallbackSeries[index])),
    border: String(border ?? '#d4d4d4'), background: String(background ?? '#fff'),
    text: String(secondary ?? '#737373'),
  };
}

function ChartHeading({ title, unit, action }: { title?: string; unit?: string; action?: React.ReactNode }) {
  return title || unit || action ? <View className="flex-row items-center justify-between" style={{ gap: richSpace.sm }}>
    <Text className="min-w-0 flex-1" style={richType.title}>{title}</Text>
    {unit ? <Text className="text-muted-foreground" style={richType.subtle}>{unit}</Text> : null}
    {action}
  </View> : null;
}

function Legend({ entries }: { entries: { name: string; color: string; lineStyle?: LineStyle }[] }) {
  return <View className="flex-row flex-wrap" style={{ columnGap: richSpace.lg, rowGap: richSpace.xs }}>{entries.map((entry, index) =>
    <View key={index} className="flex-row items-center" style={{ gap: richSpace.xs }}>
      {entry.lineStyle ? <Svg width={24} height={14} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Line x1={1} x2={23} y1={7} y2={7} stroke={entry.color} strokeWidth={2}
          strokeDasharray={entry.lineStyle.dash} />
        {entry.lineStyle.shape === 'rectangular'
          ? <Rect x={9} y={4} width={6} height={6} fill={entry.color} />
          : <Circle cx={12} cy={7} r={3} fill={entry.color} />}
      </Svg> : <View style={{ width: 10, height: 10, borderRadius: richRadius.full, backgroundColor: entry.color }} />}
      <Text className="text-muted-foreground" style={richType.subtle}>{entry.name}</Text>
    </View>)}</View>;
}

function SelectedValue({ value }: { value: string | null }) {
  return value === null ? null : <Text accessibilityLiveRegion="polite" testID="rich-chart-selected-value" selectable
    className="text-muted-foreground" style={richType.subtle}>{value}</Text>;
}
/** SVG points are not exposed to Android accessibility; keep a native raw-value list in the heading menu. */
function ChartDetails({ points, kind, title, unit, selected, children }: {
  points: { rawLabel: string; onPress: () => void }[]; kind: 'line' | 'bar';
  title?: string; unit?: string; selected: string | null; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  return <>
    <ChartHeading title={title} unit={unit} action={
      <Pressable testID={`rich-${kind}-points-toggle`} accessibilityRole="button"
        accessibilityLabel={t('{title}：查看原始数据', { title: title ?? t('图表') })} accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)} className="items-center justify-center" style={{ minHeight: richGeometry.touch, minWidth: richGeometry.touch }}>
        <Text className="text-muted-foreground" style={richType.subtle}>{open ? t('收起') : t('数据')}</Text>
      </Pressable>
    } />
    {children}
    <SelectedValue value={selected} />
    {open ? <View style={{ gap: richSpace.xs }}>{points.map((point, index) =>
      <Pressable key={index} testID={`rich-${kind}-point-${index}`} accessibilityRole="button"
        accessibilityLabel={point.rawLabel} className="justify-center border border-border"
        style={{ minHeight: richGeometry.touch, borderRadius: richRadius.small, paddingHorizontal: richSpace.sm }}
        onPress={() => { point.onPress(); setOpen(false); }}>
        <Text style={richType.body}>{point.rawLabel}</Text>
      </Pressable>)}</View> : null}
  </>;
}

/** Library draws SVG lines; only bounded display values, not raw unbounded wire values, reach it. */
export function RichLineChart({ props }: { props: LineProps }) {
  const colors = useChartColors();
  const [containerWidth, setContainerWidth] = useState<number>();
  const [selected, setSelected] = useState<string | null>(null);
  const all = props.series.flatMap((series) => series.values);
  const axis = chartValueAxis(all);
  const { fontScale } = useWindowDimensions();
  const yAxisLabelWidth = chartYAxisLabelWidth(axis.labels, fontScale);
  // Lines use a translated positive plot so a nonpositive domain ends exactly at zero.
  // Labels remain in original units; unlike bars, lines do not need signed bar baselines.
  const sections = axis.above + axis.below;
  const viewport = chartViewportProps(containerWidth ?? 0, 'line', yAxisLabelWidth);
  const layout = lineLayout(viewport.width, props.xLabels, fontScale);
  const dataSet = props.series.map((series, index) => {
    const style = lineStyles[index];
    const data = series.values.map((value, i) => {
      const rawLabel = `${series.name} · ${props.xLabels[i]}：${value}${props.unit ? ` ${props.unit}` : ''}`;
      return {
        value: axis.values[index * props.xLabels.length + i] + axis.below * 25,
        rawLabel, onPress: () => setSelected(rawLabel),
      };
    });
    return { data, color: colors.series[index], thickness: 2, strokeDashArray: style.dash,
      dataPointsShape: style.shape, dataPointsWidth: 2 * LINE_POINT_RADIUS,
      dataPointsHeight: 2 * LINE_POINT_RADIUS, dataPointsColor: colors.series[index],
      dataPointsRadius: LINE_POINT_RADIUS };
  });
  return <View style={{ flexGrow: 1, gap: richSpace.sm }} testID="rich-line-chart"
    onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
    <ChartDetails kind="line" title={props.title} unit={props.unit} selected={selected}
      points={dataSet.flatMap((series) => series.data)}>
    {/* gifted-charts paints its first rule half a section above its own box. Reserve that
        space here so its opaque background cannot cover the heading's data button. */}
    {containerWidth !== undefined && <View testID="rich-line-plot" style={{ paddingTop: richGeometry.chartHeight / sections / 2 }}>
      {/* Point insets already reserve both edges; library endSpacing would also extend every grid rule. */}
      <LineChart dataSet={dataSet} height={richGeometry.chartHeight}
        {...viewport} initialSpacing={layout.initialSpacing} endSpacing={0}
        spacing={layout.spacing} dataPointsRadius={LINE_POINT_RADIUS} disableScroll
        maxValue={sections * 25} noOfSections={sections} stepValue={25}
        stepHeight={richGeometry.chartHeight / sections} noOfSectionsBelowXAxis={0}
        yAxisLabelTexts={axis.labels}
        yAxisTextStyle={{ color: colors.text, ...richType.subtle }}
        xAxisLabelsHeight={0} xAxisColor={colors.border} yAxisColor={colors.border} rulesColor={colors.border}
        backgroundColor={colors.background} isAnimated={false} />
      {/* Slots stay inside the horizontal viewport; in-flow labels determine their actual height. */}
      <View style={{ minHeight: richType.subtle.lineHeight * 3 * fontScale, marginLeft: viewport.yAxisLabelWidth + 1, flexDirection: 'row', alignItems: 'flex-start' }}>
        {layout.ticks.map((tick, index) => <Text key={tick.index} testID={`rich-line-label-${tick.index}`}
          style={{ marginLeft: tick.left - (index ? layout.ticks[index - 1].left + layout.labelWidth : 0),
            width: layout.labelWidth, flexShrink: 0, textAlign: 'center', ...richType.subtle }}
          className="text-muted-foreground">{tick.label}</Text>)}
      </View>
    </View>}
    {/* Stretched Grid cells share the tallest chart's space; shorter labels leave it above the legend. */}
    <View style={{ marginTop: 'auto' }} testID="rich-line-legend">
      <Legend entries={props.series.map((series, index) => ({
        name: series.name, color: colors.series[index], lineStyle: lineStyles[index],
      }))} />
    </View>
    </ChartDetails>
  </View>;
}

export function RichBarChart({ props }: { props: BarProps }) {
  const colors = useChartColors();
  const drawerPan = useContext(DrawerGestureContext);
  const [containerWidth, setContainerWidth] = useState<number>();
  const [selected, setSelected] = useState<string | null>(null);
  const axis = chartValueAxis(props.values);
  const data = axis.values.map((value, index) => {
    const rawLabel = `${props.labels[index]}：${props.values[index]}${props.unit ? ` ${props.unit}` : ''}`;
    return { value, label: props.labels[index], rawLabel, onPress: () => setSelected(rawLabel) };
  });
  const { fontScale } = useWindowDimensions();
  const yAxisLabelWidth = chartYAxisLabelWidth(axis.labels, fontScale);
  // Keep the native below-zero sections within the same plot height.
  const sectionHeight = richGeometry.chartHeight / (axis.above + axis.below);
  const viewport = chartViewportProps(containerWidth ?? 0, 'bar', yAxisLabelWidth);
  // Gifted's ScrollView is private: it offers no renderer/scroll-view prop to bind a Native
  // handler. In chat, scroll the whole chart (including its axis) instead, with Gifted's
  // internal scrolling disabled. Outside the drawer keep the existing chart unchanged.
  const plotWidth = drawerPan
    ? Math.max(viewport.width, 2 * richSpace.md + props.values.length * (richSpace.lg + richSpace.md))
    : viewport.width;
  const chartWidth = viewport.yAxisLabelWidth + 1 + plotWidth;
  const chart = <BarChart data={data}
    height={axis.above * sectionHeight} initialSpacing={richSpace.md} endSpacing={richSpace.md}
    {...viewport} width={plotWidth} {...barLayout(plotWidth, props.values.length)}
    maxValue={axis.above * 25} noOfSections={axis.above} stepValue={25}
    stepHeight={sectionHeight} negativeStepHeight={sectionHeight}
    noOfSectionsBelowXAxis={axis.below} mostNegativeValue={-axis.below * 25}
    yAxisLabelTexts={axis.labels}
    frontColor={colors.series[0]} barBorderRadius={richGeometry.chartBarRadius}
    yAxisTextStyle={{ color: colors.text, ...richType.subtle }}
    xAxisLabelTextStyle={{ color: colors.text, ...richType.subtle }} xAxisTextNumberOfLines={1}
    xAxisColor={colors.border} yAxisColor={colors.border} rulesColor={colors.border}
    backgroundColor={colors.background} isAnimated={false} {...(drawerPan ? { disableScroll: true } : {})} />;
  return <View style={{ gap: richSpace.sm }} testID="rich-bar-chart"
    onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
    <ChartDetails kind="bar" title={props.title} unit={props.unit} selected={selected} points={data}>
    {/* Gifted overdraws half a section upward; reserve that space inside the clipping scroll content. */}
    {containerWidth !== undefined && <View testID="rich-bar-plot" style={drawerPan ? undefined : { paddingTop: sectionHeight / 2 }}>
      {drawerPan
        ? <DrawerHorizontalGesture><ScrollView horizontal scrollEnabled={chartWidth > containerWidth}
          showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} testID="rich-bar-scroll"
          contentContainerStyle={{ paddingTop: sectionHeight / 2 }}>
          <View style={{ width: chartWidth }}>{chart}</View>
        </ScrollView></DrawerHorizontalGesture>
        : chart}
    </View>}
    </ChartDetails>
  </View>;
}

export function RichPieChart({ props }: { props: PieProps }) {
  const colors = useChartColors();
  const [selected, setSelected] = useState<string | null>(null);
  // Divide before summing: two legal positive ~1e308 numbers would overflow a raw total.
  const max = props.items.reduce((largest, item) => Math.max(largest, item.value), 0);
  const weights = props.items.map((item) => item.value / max);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const shades = colors.series;
  return <View style={{ gap: richSpace.sm }} testID="rich-pie-chart">
    <ChartHeading title={props.title} unit={props.unit} />
    <View className="items-center"><PieChart data={weights.map((value, index) => ({ value, color: shades[index] }))}
      radius={66} strokeWidth={1} strokeColor={colors.background} backgroundColor={colors.background} /></View>
    <View testID="rich-pie-legend">{props.items.map((item, index) => <Pressable key={index}
      testID={`rich-pie-point-${index}`} accessibilityRole="button"
      accessibilityLabel={`${item.label}：${item.value}${props.unit ? ` ${props.unit}` : ''}`}
      onPress={() => setSelected(`${item.label}：${item.value}${props.unit ? ` ${props.unit}` : ''}`)}
      className={`flex-row items-center${index ? ' border-border border-t' : ''}`}
      style={{ gap: richSpace.sm, paddingVertical: richSpace.xs }}>
      <View style={{ width: 10, height: 10, borderRadius: richRadius.full, backgroundColor: shades[index] }} />
      <Text className="flex-1" style={richType.subtle}>{item.label}</Text>
      <Text className="text-muted-foreground" style={richType.subtle}>{`${Number(((weights[index] / total) * 100).toPrecision(3))}% · ${item.value}`}</Text>
    </Pressable>)}</View>
    <SelectedValue value={selected} />
  </View>;
}
