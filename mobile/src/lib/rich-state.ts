import type { RichSpec } from '../components/rich-message/spec.ts';
import { displayFieldValue } from '../components/rich-message/spec.ts';

type RenderSpec = Omit<RichSpec, 'elements'> & {
  elements: Record<string, Omit<RichSpec['elements'][string], 'visible'> & { visible: boolean }>;
};

/** ADR-0081 deliberately uses non-empty arrays, unlike json-render's Boolean([]).
 * Equality is JSON value equality, not coercion or expression evaluation. */
export function richVisible(condition: RichSpec['elements'][string]['visible'], state: Record<string, unknown>): boolean {
  if (!condition) return true;
  const value = state[condition.$state.slice(1)];
  const equals = (expected: unknown) => Array.isArray(value) && Array.isArray(expected)
    ? value.length === expected.length && value.every((item, index) => item === expected[index])
    : value === expected;
  const result = 'eq' in condition ? equals(condition.eq) : 'neq' in condition ? !equals(condition.neq) :
    Array.isArray(value) ? value.length > 0 : Boolean(value);
  return condition.not ? !result : result;
}

/** Project the allowlisted read-only bindings. Input values stay in the single json-render store;
 * option identifiers are never exposed as display text. No expression evaluation occurs here. */
export function resolveRichBindings(spec: RichSpec, state: Record<string, unknown>): RenderSpec {
  const text = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || !('$state' in value)) return value;
    const key = String(value.$state).slice(1);
    const raw = state[key];
    if (raw === null || raw === undefined || raw === '' || Array.isArray(raw) && !raw.length) return '—';
    const field = Object.values(spec.elements).find(node => node.props.stateKey === key);
    return field ? displayFieldValue(field.type, field.props.options, raw) : String(raw);
  };
  return { ...spec, elements: Object.fromEntries(Object.entries(spec.elements).map(([id, node]) => {
    const props = node.props;
    const { visible: _visible, ...plain } = node;
    const rendered = { ...plain, visible: richVisible(node.visible, state),
      children: node.type === 'Tabs' ? node.children : node.children.filter(child => richVisible(spec.elements[child].visible, state)) };
    if (node.type === 'ButtonRow') {
      rendered.children.sort((a, b) => Number(spec.elements[a].type === 'Submit') - Number(spec.elements[b].type === 'Submit'));
      return [id, { ...rendered, props: { ...props, __childTypes: rendered.children.map(child => spec.elements[child].type) } }];
    }
    if (node.type === 'Text' || node.type === 'Heading' || node.type === 'Copy') return [id, { ...rendered, props: { ...props, text: text(props.text) } }];
    if (node.type === 'Field' || node.type === 'StatCard') return [id, { ...rendered, props: { ...props, value: text(props.value),
      ...(node.type === 'Field' && props.value !== null && typeof props.value === 'object'
        ? { __boundStateKey: String(props.value.$state).slice(1) } : {}) } }];
    if (node.type === 'KeyValue') return [id, { ...rendered, props: { ...props, items: props.items.map((item: { label: string; value: unknown }) => ({ ...item, value: text(item.value) })) } }];
    return [id, rendered];
  })) };
}
