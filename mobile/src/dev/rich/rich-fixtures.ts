import { parseRichSpec, type RichSpec } from '@/components/rich-message/spec';
import { splitAgentMessage } from '@/lib/agent-message';
import { richScenarios } from '../rich-scenarios';

export type RichFixture = {
  spec: RichSpec;
  files?: Record<string, string>;
  attachments?: { id: string; media_type: string }[];
};
type Component = RichSpec['elements'][string]['type'];
type Node = { type: Component; props: Record<string, unknown>; children: Node[]; width?: RichSpec['elements'][string]['width']; visible?: RichSpec['elements'][string]['visible'] };
export const node = (type: Component, props: Record<string, unknown> = {}, ...children: Node[]): Node => ({ type, props, children });
export const sized = (width: NonNullable<Node['width']>, value: Node): Node => ({ ...value, width });

/** Only story-local gaps/variants use new data; the normal examples come from rich-scenarios. */
export function fixture(root: Node, state: Record<string, unknown> = {}): RichFixture {
  const elements: RichSpec['elements'] = {};
  let count = 0;
  function visit(value: Node): string {
    const id = `story${count++}`;
    elements[id] = { type: value.type, props: value.props, children: value.children.map(visit),
      ...(value.width === undefined ? {} : { width: value.width }),
      ...(value.visible === undefined ? {} : { visible: value.visible }) };
    return id;
  }
  return { spec: { root: visit(root), elements, state } };
}

/** Keep the selected subtree, its exact field state and its message's media grants. */
export function fromScenario(id: string, component: Component, occurrence = 0): RichFixture {
  const scenario = richScenarios.find(item => item.id === id);
  if (!scenario) throw new Error(`Unknown rich scenario: ${id}`);
  const specs = splitAgentMessage(scenario.text).flatMap(part => {
    if (part.kind !== 'ui') return [];
    const spec = parseRichSpec(part.source);
    if (!spec) throw new Error(`Invalid rich scenario: ${id}`);
    return [spec];
  });
  const matches = specs.flatMap(spec => Object.entries(spec.elements)
    .filter(([, element]) => element.type === component).map(([root]) => ({ spec, root })));
  const selected = matches[occurrence];
  if (!selected) throw new Error(`Missing ${component} in rich scenario: ${id}`);
  const elements: RichSpec['elements'] = {};
  const state: RichSpec['state'] = {};
  function visit(key: string) {
    const element = selected.spec.elements[key];
    elements[key] = element;
    if (typeof element.props.stateKey === 'string') state[element.props.stateKey] = selected.spec.state[element.props.stateKey];
    element.children.forEach(visit);
  }
  visit(selected.root);
  let root = selected.root;
  // The real Spec contract requires exactly one Submit whenever inputs exist.
  if (Object.keys(state).length && !Object.values(elements).some(element => element.type === 'Submit')) {
    elements.storySubmit = { type: 'Submit', props: { label: '提交预览' }, children: [] };
    elements.storyRoot = { type: 'Stack', props: {}, children: [root, 'storySubmit'] };
    root = 'storyRoot';
  }
  return { spec: { root, elements, state }, files: scenario.files, attachments: scenario.attachments };
}
