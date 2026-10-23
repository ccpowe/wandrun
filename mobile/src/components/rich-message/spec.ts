import { z } from 'zod';
import { toASCII } from 'tr46';
import iconNames from '../../../../src/wandrun/gateway/ui_icons.json' with { type: 'json' };
import { getLocale, t } from '../../lib/i18n.ts';

function codepoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; count++) {
    index += value.codePointAt(index)! > 0xffff ? 2 : 1;
  }
  return count;
}
const bounded = (limit: number) => z.string().refine((value) => codepoints(value) <= limit);
const short = bounded(80);
const long = bounded(500);
const key = z.string().refine((value) =>
  /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.exec(value)?.[0] === value &&
  value !== 'constructor' && value !== 'prototype' && value !== '__proto__');
const optionValue = short.min(1);
const tone = z.enum(['neutral', 'active', 'success', 'warning', 'error', 'info']);
const iconName = z.enum(iconNames as [string, ...string[]]);
/** Syntax-only delivery validation; the gateway separately owns DNS and download policy. */
const webUrl = z.string().min(1).refine((value) => {
  if (codepoints(value) > 2048 || !/^https?:\/\//.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  const authority = /^[^/?#]*/.exec(value.slice(value.indexOf('://') + 3))![0];
  if (authority.includes('@') || authority.includes('%')) return false;
  try {
    const url = new URL(value);
    if (!url.hostname || url.port === '0') return false;
    if (authority.startsWith('[')) return url.hostname.startsWith('[');
    const host = authority.split(':', 1)[0];
    if (/^[\x00-\x7f]*$/.test(host) && host.toLowerCase() !== url.hostname) return false;
    const labels = host.replace(/\.$/, '').split('.');
    if (/^\p{Nd}+$/u.test(labels.at(-1)!) || labels.at(-1)!.toLowerCase().startsWith('0x'))
      return /^\d+\.\d+\.\d+\.\d+$/.test(host) && host === url.hostname;
    if (!labels.every((label) => label.length > 0 && /^[\p{L}\p{M}\p{Nd}-]+$/u.test(label))) return false;
    // Same non-transitional UTS #46 / STD3 policy as gateway's idna.encode.
    const ascii = toASCII(labels.join('.'), { checkBidi: true, checkHyphens: true, checkJoiners: true,
      transitionalProcessing: false, useSTD3ASCIIRules: true, verifyDNSLength: true });
    return ascii !== null && ascii.length + Number(host.endsWith('.')) <= 253 && ascii === url.hostname.replace(/\.$/, '');
  } catch {
    return false;
  }
});
const badge = z.strictObject({ text: long, tone });
const choice = z.strictObject({ value: optionValue, label: short, description: long.optional(), tags: z.array(short).optional(), disabled: z.boolean().optional() });
const segment = z.strictObject({ value: optionValue, label: short });
const multiple = z.strictObject({ value: optionValue, label: short, note: long.optional() });
const percent = z.number().finite().min(0).max(100);
const finite = z.number().finite();
const chartTitle = bounded(80);
const chartLabel = bounded(20);
const chartName = bounded(40);
const chartUnit = bounded(10);
const imageFields = { alt: bounded(200), caption: bounded(200).optional() };
const image = z.union([
  z.strictObject({ attachment: z.string().min(1), ...imageFields }),
  z.strictObject({ url: webUrl, ...imageFields }),
]);
const cardFields = { ...imageFields, title: short, description: long.optional(),
  tags: z.array(short).max(6).optional(), direction: z.enum(['horizontal', 'vertical']).optional() };
const mediaCard = z.union([
  z.strictObject({ attachment: z.string().min(1), ...cardFields }),
  z.strictObject({ url: webUrl, ...cardFields }),
]);

const fileTreeNode = z.strictObject({
  path: bounded(200).min(1),
  kind: z.enum(['folder', 'file']).optional(),
  note: bounded(60).optional(),
  collapsed: z.boolean().optional(),
});

/** Paths identify display nodes, not filesystem access; a trailing slash aliases the same folder. */
function validFileTree(nodes: z.infer<typeof fileTreeNode>[]): boolean {
  const paths = new Map<string, 'folder' | 'file' | undefined>();
  for (const node of nodes) {
    const path = node.path.replace(/\/$/, '');
    const segments = path.split('/');
    if (segments.length > 8 || segments.some((part) => !part || part === '.' || part === '..' ||
        codepoints(part) > 64) || /[\\\u0000-\u001f\u007f]/.test(node.path) ||
        paths.has(path) || node.kind === 'file' && node.path.endsWith('/')) return false;
    paths.set(path, node.kind ?? (node.path.endsWith('/') ? 'folder' : undefined));
  }
  for (const path of paths.keys()) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      if (paths.get(segments.slice(0, depth).join('/')) === 'file') return false;
    }
  }
  return true;
}


/** Defensive renderer validation; rich_catalog_validation.test.ts compares every constraint with the authoritative catalog. */
export const componentSchemas = {
  Stack: z.strictObject({ direction: z.enum(['vertical', 'horizontal']).optional(), gap: z.enum(['sm', 'md']).optional(), justify: z.enum(['start', 'between']).optional() }),
  Card: z.strictObject({ title: short.optional() }),
  Divider: z.strictObject({}),
  Heading: z.strictObject({ text: long }),
  Text: z.strictObject({ text: long, tone: z.enum(['default', 'muted']).optional() }),
  Badge: z.strictObject({ text: long, tone: tone.optional() }),
  Status: z.strictObject({ title: short, badge: badge.optional(), progress: percent.optional(), caption: long.optional() }),
  Metrics: z.strictObject({ items: z.array(z.strictObject({ label: short, value: short, hint: long.optional() })).min(1).max(4) }),
  KeyValue: z.strictObject({ items: z.array(z.strictObject({ label: short, value: short })).min(1).max(12) }),
  Steps: z.strictObject({ items: z.array(z.strictObject({ label: short, state: z.enum(['done', 'current', 'todo', 'failed']), note: long.optional() })).min(1).max(10) }),
  Progress: z.strictObject({ value: percent, caption: long.optional() }),
  Table: z.strictObject({ columns: z.array(short).min(1).max(5), rows: z.array(z.array(z.union([short, z.strictObject({ badge })]))).min(1).max(12) }),
  ChoiceGroup: z.strictObject({ stateKey: key, label: short.optional(), options: z.array(choice).min(2).max(8) }),
  Select: z.strictObject({ stateKey: key, label: short.optional(), options: z.array(z.strictObject({ value: optionValue, label: short, disabled: z.boolean().optional() })).min(2).max(12) }),
  Segmented: z.strictObject({ stateKey: key, label: short.optional(), options: z.array(segment).min(2).max(5) }),
  MultiSelect: z.strictObject({ stateKey: key, label: short.optional(), variant: z.enum(['chips', 'checklist']).optional(), options: z.array(multiple).min(2).max(12) }),
  Switch: z.strictObject({ stateKey: key, label: short }),
  Slider: z.strictObject({ stateKey: key, label: short, min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive() }),
  TextInput: z.strictObject({ stateKey: key, label: short, placeholder: long.optional(), multiline: z.boolean().optional() }),
  DateInput: z.strictObject({ stateKey: key, label: short }),
  Submit: z.strictObject({ label: short }),
  LineChart: z.strictObject({ title: chartTitle.optional(), xLabels: z.array(chartLabel).min(2).max(24), series: z.array(z.strictObject({ name: chartName, values: z.array(finite) })).min(1).max(3), unit: chartUnit.optional() }),
  BarChart: z.strictObject({ title: chartTitle.optional(), labels: z.array(chartLabel).min(1).max(12), values: z.array(finite.nonnegative()), unit: chartUnit.optional() }),
  PieChart: z.strictObject({ title: chartTitle.optional(), items: z.array(z.strictObject({ label: chartName, value: finite.positive() })).min(2).max(6), unit: chartUnit.optional() }),
  Tabs: z.strictObject({ tabs: z.array(z.strictObject({ label: chartLabel })).min(2).max(5) }),
  Accordion: z.strictObject({ title: chartTitle, defaultOpen: z.boolean().optional() }),
  Grid: z.strictObject({ columns: z.union([z.literal(2), z.literal(3)]) }),
  Source: z.strictObject({ items: z.array(z.strictObject({ url: webUrl, title: short.optional() })).min(1).max(8) }),
  LinkCard: z.strictObject({ url: webUrl, title: short, description: long.optional(),
    image: webUrl.optional(), tags: z.array(bounded(12)).max(3).optional() }),
  FileTree: z.strictObject({ title: bounded(40).optional(), nodes: z.array(fileTreeNode).min(1).max(80) }),
  Icon: z.strictObject({ name: iconName, label: short.optional(), size: z.enum(['sm', 'md', 'lg']).optional() }),
  List: z.strictObject({ ordered: z.boolean().optional(), items: z.array(z.strictObject({ text: long, icon: iconName.optional() })).min(1).max(12) }),
  Callout: z.strictObject({ tone: z.enum(['info', 'success', 'warning', 'error']), title: short.optional(), text: long }),
  Quote: z.strictObject({ text: long, attribution: short.optional() }),
  Math: z.strictObject({ tex: bounded(2048), display: z.boolean().optional() }),
  Image: image,
  MediaCard: mediaCard,
  Gallery: z.strictObject({ items: z.array(image).min(1).max(8) }),
  Mermaid: z.strictObject({ source: bounded(10000).min(1), title: short.optional() }),
} as const;

export const richComponentNames = Object.keys(componentSchemas) as (keyof typeof componentSchemas)[];
type Element = { type: keyof typeof componentSchemas; props: Record<string, any>; children: string[] };
export type RichSpec = { root: string; elements: Record<string, Element>; state: Record<string, unknown> };
export type SubmissionFailure = { message: string; retryable: boolean; editable: boolean };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const dangerous = { ['__proto__']: true, prototype: true, constructor: true } as const;
function safeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(safeKeys);
  if (!object(value)) return true;
  return Object.keys(value).every((name) => !Object.hasOwn(dangerous, name) && safeKeys(value[name]));
}
const inputTypes: Record<string, true> = { ChoiceGroup: true, Select: true, Segmented: true, MultiSelect: true, Switch: true, Slider: true, TextInput: true, DateInput: true };

/** Decimal spellings are the wire contract: binary float closeness is not step alignment. */
function decimal(value: number): { digits: bigint; places: number } {
  const [, sign, whole, fraction = '', exponent = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value))!;
  const digits = BigInt(`${sign}${whole}${fraction}`);
  const places = fraction.length - Number(exponent);
  return places < 0 ? { digits: digits * 10n ** BigInt(-places), places: 0 } : { digits, places };
}

function sliderGrid(min: number, max: number, step: number, value: number): { low: bigint; high: bigint; stride: bigint; point: bigint; places: number } {
  const first = decimal(min);
  const last = decimal(max);
  const interval = decimal(step);
  const current = decimal(value);
  const places = Math.max(first.places, last.places, interval.places, current.places);
  return {
    low: first.digits * 10n ** BigInt(places - first.places),
    high: last.digits * 10n ** BigInt(places - last.places),
    stride: interval.digits * 10n ** BigInt(places - interval.places),
    point: current.digits * 10n ** BigInt(places - current.places),
    places,
  };
}

function validSliderValue(min: number, max: number, step: number, value: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || !Number.isFinite(value) || step <= 0 || max < min) return false;
  return value >= min && value <= max && value === alignedSliderValue(min, max, step, value);
}

function validValue(node: Element, value: unknown): boolean {
  const { type, props } = node;
  if (type === 'ChoiceGroup' || type === 'Select' || type === 'Segmented') return typeof value === 'string' && (value === '' || props.options.some((o: { value: string }) => o.value === value));
  if (type === 'MultiSelect') return Array.isArray(value) && new Set(value).size === value.length && value.every((item) => typeof item === 'string' && props.options.some((o: { value: string }) => o.value === item));
  if (type === 'Switch') return typeof value === 'boolean';
  if (type === 'Slider') return typeof value === 'number' && validSliderValue(props.min, props.max, props.step, value);
  if (type === 'TextInput') return typeof value === 'string' && codepoints(value) <= 2000;
  if (type === 'DateInput') {
    if (typeof value !== 'string') return false;
    if (value === '') return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  return false;
}

/** Snap native floats to the JS-number projection of the exact decimal step grid. */
export function alignedSliderValue(min: number, max: number, step: number, raw: number): number {
  if (!Number.isFinite(raw)) return min;
  const { low, high, stride, point, places } = sliderGrid(min, max, step, raw);
  const bounded = point < low ? low : point > high ? high : point;
  const steps = ((bounded - low) * 2n + stride) / (2n * stride);
  const aligned = low + (steps > (high - low) / stride ? (high - low) / stride : steps) * stride;
  const unit = 10n ** BigInt(places);
  const magnitude = aligned < 0n ? -aligned : aligned;
  const spelling = `${aligned < 0n ? '-' : ''}${magnitude / unit}.${String(magnitude % unit).padStart(places, '0')}`;
  return Number(spelling);
}

/** Return null instead of exposing malformed or unknown specs to json-render (which may throw during render). */
export function parseRichSpec(source: string): RichSpec | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (!object(parsed) || !safeKeys(parsed) || Object.keys(parsed).some((k) => !['root', 'elements', 'state'].includes(k))) return null;
    const { root, elements, state } = parsed;
    if (typeof root !== 'string' || !key.safeParse(root).success || !object(elements) || !object(state)) return null;
    const ids = Object.keys(elements);
    if (ids.length < 1 || ids.length > 60 || !Object.hasOwn(elements, root) || ids.some((id) => !key.safeParse(id).success)) return null;
    const nodes: Record<string, Element> = Object.create(null);
    for (const id of ids) {
      const element = elements[id];
      if (!object(element) || typeof element.type !== 'string' || !Object.hasOwn(componentSchemas, element.type) ||
          !object(element.props) || !Array.isArray(element.children) ||
          Object.keys(element).some((name) => !['type', 'props', 'children'].includes(name)) ||
          !element.children.every((child) => typeof child === 'string')) return null;
      const type = element.type as Element['type'];
      const props = componentSchemas[type].safeParse(element.props);
      if (!props.success) return null;
      if (!['Stack', 'Card', 'Grid', 'Tabs', 'Accordion'].includes(type) && element.children.length !== 0) return null;
      if (type === 'ChoiceGroup' || type === 'Select' || type === 'Segmented' || type === 'MultiSelect') {
        const options = (props.data as z.infer<typeof componentSchemas.ChoiceGroup>).options;
        if (new Set(options.map((option) => option.value)).size !== options.length) return null;
      }
      if (type === 'Table') {
        const table = props.data as z.infer<typeof componentSchemas.Table>; // Parsed by the Table schema above.
        if (table.rows.some((row) => row.length !== table.columns.length)) return null;
      }
      if (type === 'LineChart') {
        const chart = props.data as z.infer<typeof componentSchemas.LineChart>;
        if (chart.series.some((series) => series.values.length !== chart.xLabels.length)) return null;
      }
      if (type === 'BarChart') {
        const chart = props.data as z.infer<typeof componentSchemas.BarChart>;
        if (chart.values.length !== chart.labels.length) return null;
      }
      if (type === 'FileTree' && !validFileTree((props.data as z.infer<typeof componentSchemas.FileTree>).nodes)) return null;
      if (type === 'Tabs' && element.children.length !== (props.data as z.infer<typeof componentSchemas.Tabs>).tabs.length) return null;
      if (type === 'Slider') {
        const slider = props.data as z.infer<typeof componentSchemas.Slider>;
        if (slider.max < slider.min) return null;
      }
      nodes[id] = { type, props: props.data, children: element.children as string[] };
    }
    const seen = new Set<string>();
    const walk = (id: string, depth: number): boolean => {
      if (depth > 8 || seen.has(id) || !Object.hasOwn(nodes, id)) return false;
      seen.add(id);
      return nodes[id].children.every((child) => walk(child, depth + 1));
    };
    if (!walk(root, 1) || seen.size !== ids.length) return null;
    const fields = Object.values(nodes).filter((node) => Object.hasOwn(inputTypes, node.type));
    const keys = fields.map((node) => node.props.stateKey as string);
    if (new Set(keys).size !== keys.length || Object.keys(state).length !== keys.length ||
        keys.some((name) => !Object.hasOwn(state, name)) ||
        fields.some((node) => !validValue(node, state[node.props.stateKey])) ||
        Object.values(nodes).filter((node) => node.type === 'Submit').length !== (fields.length > 0 ? 1 : 0)) return null;
    return { root, elements: nodes, state: { ...state } };
  } catch {
    return null;
  }
}

/** Extract exactly the form keys; don't submit unrelated values added by a renderer or malformed historical state. */
export function submissionValues(spec: RichSpec, snapshot: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null);
  for (const node of Object.values(spec.elements)) {
    if (Object.hasOwn(inputTypes, node.type)) values[node.props.stateKey] = snapshot[node.props.stateKey];
  }
  return values;
}

/** Human-readable value, never a raw option identifier, for persisted read-only cards. */
export function displayFieldValue(type: Element['type'], options: { value: string; label: string }[] | undefined, raw: unknown): string {
  const lookup = (value: unknown) => options?.find((option) => option.value === value)?.label ?? String(value);
  const display = Array.isArray(raw) ? raw.map(lookup).join(getLocale() === 'zh-CN' ? '、' : ', ') :
    type === 'ChoiceGroup' || type === 'Select' || type === 'Segmented' ? (options?.find((option) => option.value === raw)?.label ?? (raw ? String(raw) : '')) :
    type === 'Switch' ? (raw ? t('是') : t('否')) : String(raw ?? '');
  return display || t('未填写');
}

export function fieldSummaries(spec: RichSpec, values: Record<string, unknown>): { label: string; value: string }[] {
  return Object.values(spec.elements).filter((node) => Object.hasOwn(inputTypes, node.type)).map((node) => {
    const { props, type } = node;
    const display = displayFieldValue(type, props.options, values[props.stateKey]);
    return { label: props.label || t('选择'), value: display };
  });
}

export function submissionError(error: unknown): SubmissionFailure {
  const reason = object(error) ? error : {};
  const code = reason.code;
  if (code === 'ui_already_submitted') return { message: t('这个界面已在其他设备提交。'), retryable: false, editable: false };
  if (code === 'ui_block_not_found') return { message: t('界面已失效或找不到，请刷新对话。'), retryable: false, editable: false };
  if (code === 'collaboration_unavailable') return { message: t('这个协作已无法继续'), retryable: false, editable: false };
  if (code === 'collaboration_stopped') return {
    message: typeof reason.message === 'string' ? reason.message : t('请先从上级会话恢复。'),
    retryable: true, editable: false,
  };
  if (code === 'ui_invalid_values') {
    const details = object(reason.details) ? reason.details : {};
    const errors = Object.entries(details).filter(([, text]) => typeof text === 'string')
      .map(([field, text]) => t('「{field}」：{text}', { field, text: String(text) })).join(t('；'));
    return { message: errors ? t('提交内容不合法：{errors}', { errors }) : t('提交内容不合法，请检查输入内容。'), retryable: false, editable: true };
  }
  return { message: t('提交结果尚未确认，请保持当前选择后重试。'), retryable: true, editable: false };
}

export function pointerForKey(name: string): string {
  return `/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
