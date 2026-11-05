import { createContext, useContext, useState } from 'react';
import { Linking, Pressable, ScrollView, View, Platform } from 'react-native';
import type { MediaLocation, ImageItem } from './media.tsx';
import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { MediaCard, MediaGallery, MediaPicture } from './media.tsx';
import { MermaidPicture } from './mermaid.tsx';
import { defineCatalog } from '@json-render/core';
import { defineRegistry } from '@json-render/react-native';
import { schema } from '@json-render/react-native/schema';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import type { GatewayApi } from '@/gateway/api.ts';
import { useTranslation } from '../../lib/i18n.ts';
import { sourceSite } from './source-site.ts';
import { useCSSVariable } from 'uniwind';
import { z } from 'zod';

import { Icon } from '@/components/ui/icon.tsx';
import { Text as UIText } from '@/components/ui/text.tsx';
import { AccordionDisplay, BadgeDisplay, CalloutDisplay, CardDisplay, DividerDisplay, HeadingDisplay, IconDisplay, KeyValueDisplay, ListDisplay, MetricsDisplay, ProgressDisplay, QuoteDisplay, StatusDisplay, StepsDisplay, TableDisplay, TabsDisplay, TextDisplay } from './display.tsx';
import { FileTreeDisplay } from './file-tree.tsx';
import { ButtonRowDisplay, FieldDisplay, StatCardDisplay } from './composites.tsx';
import { ChoiceGroupField, DateInputField, MultiSelectField, SegmentedField, SelectField, SliderField, SubmitField, SwitchField, TextInputField } from './inputs.tsx';
import { CopyAction, FollowUpsDisplay } from './actions.tsx';
import { LinkCardDisplay } from './link-card.tsx';
import { RichMath, RichText } from './math.tsx';
import { RichBarChart, RichLineChart, RichPieChart } from './charts.tsx';
import { componentSchemas } from './spec.ts';
import { GridDisplay, ScrollRowDisplay, StackDisplay } from './layouts.tsx';
import { richGeometry, richRadius, richSourceColors, richSpace, richType } from './tokens.ts';

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
    ScrollRow: { props: componentSchemas.ScrollRow, slots: container, description: '横滑内容' },
    Field: { props: componentSchemas.Field, slots: container, description: '标签与控件' },
    ButtonRow: { props: componentSchemas.ButtonRow, slots: container, description: '动作行' },
    Card: { props: componentSchemas.Card, slots: container, description: '卡片' },
    Divider: { props: componentSchemas.Divider, slots: leaf, description: '分隔线' },
    Heading: { props: componentSchemas.Heading, slots: leaf, description: '标题' },
    Text: { props: componentSchemas.Text, slots: leaf, description: '说明文字' },
    Badge: { props: componentSchemas.Badge, slots: leaf, description: '状态标记' },
    Status: { props: componentSchemas.Status, slots: leaf, description: '状态摘要' },
    Metrics: { props: componentSchemas.Metrics, slots: leaf, description: '指标' },
    StatCard: { props: componentSchemas.StatCard, slots: leaf, description: '只读统计卡' },
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
    Copy: { props: componentSchemas.Copy, slots: leaf, description: '本地复制' },
    FollowUps: { props: componentSchemas.FollowUps, slots: leaf, description: '追问建议' },
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

export { RichInteractionContext } from './inputs.tsx';
export const RichImageContext = createContext<MediaOwner>({});
const Subtle = ({ children }: { children: React.ReactNode }) => <RichText className="text-muted-foreground" style={richType.subtle}>{children}</RichText>;
function ImageDisplay({ props, elementId }: { props: z.infer<typeof componentSchemas.Image>; elementId: string }) {
  const owner = useContext(RichImageContext);
  // `RichImage.*`: no frame around the picture (A+); the caption sits directly below it.
  return <View style={{ gap: richSpace.sm }} testID="rich-image-card">
    <MediaPicture api={owner.api} location={locationFor(owner, elementId, 0, 'url' in props || !!fileFor(owner, props))}
      fileId={fileFor(owner, props)} alt={props.alt} />
    {props.caption ? <Subtle>{props.caption}</Subtle> : null}
  </View>;
}

function SourceDisplay({ props }: { props: z.infer<typeof componentSchemas.Source> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const sourceColors = useCSSVariable([...richSourceColors]);
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
            marginLeft: index ? -richGeometry.sourceMarkOverlap : 0, backgroundColor: String(sourceColors[site.colorIndex]) }}>
          <UIText allowFontScaling={false} style={richType.caption} className="text-source-foreground">{site.letter}</UIText>
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
              flexShrink: 0, borderRadius: richRadius.full, backgroundColor: String(sourceColors[source.site.colorIndex]) }}>
            <UIText allowFontScaling={false} className="text-source-foreground" style={richType.caption}>{source.site.letter}</UIText>
          </View>
          {/* Strip only www.; the accessible label and open action keep the full original destination. */}
          <UIText numberOfLines={1} className="text-muted-foreground" style={{ ...richType.caption, flexShrink: 1 }}>{source.host.replace(/^www\./, '')}</UIText>
        </View>
      </Pressable>)}
    </ScrollView></DrawerHorizontalGesture> : null}
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
    Stack: StackDisplay,
    ScrollRow: ScrollRowDisplay,
    Field: FieldDisplay,
    ButtonRow: ButtonRowDisplay,
    Card: CardDisplay,
    Divider: DividerDisplay,
    Heading: HeadingDisplay,
    Text: TextDisplay,
    Badge: BadgeDisplay,
    Status: StatusDisplay,
    Metrics: MetricsDisplay,
    KeyValue: KeyValueDisplay,
    StatCard: ({ props }) => <StatCardDisplay props={props} elementId={(props as typeof props & { __elementId: string }).__elementId} />,
    Steps: StepsDisplay,
    Progress: ProgressDisplay,
    Table: TableDisplay,
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
    Icon: IconDisplay,
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
    Submit: ({ props }) => <SubmitField props={props} elementId={(props as typeof props & { __elementId: string }).__elementId} />,
    Copy: CopyAction,
    FollowUps: ({ props }) => <FollowUpsDisplay props={props} elementId={(props as typeof props & { __elementId: string }).__elementId} />,
  },
});
