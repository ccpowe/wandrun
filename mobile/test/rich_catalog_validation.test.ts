import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { componentSchemas, parseRichSpec } from '../src/components/rich-message/spec.ts';

import { GatewayApi, GatewayError } from '../src/gateway/api.ts';
const numberCases = JSON.parse(readFileSync(new URL('../../tests/fixtures/ui_numbers.json', import.meta.url), 'utf8')) as {
  name: string; source: string; valid: boolean;
}[];

for (const { name, source, valid } of numberCases) {
  test(`shared raw JSON numbers: ${name}`, () => {
    // Parse the original literal; stringify would turn overflow into null.
    assert.equal(parseRichSpec(source) !== null, valid);
  });
}
const urlCases = JSON.parse(readFileSync(new URL('../../tests/fixtures/ui_urls.json', import.meta.url), 'utf8')) as {
  name: string; url: string; valid: boolean;
}[];
for (const { name, url, valid } of urlCases) {
  test(`shared browser URL: ${name}`, () => {
    for (const [type, props] of [
      ['Source', { items: [{ url }] }],
      ['LinkCard', { url, title: 'Reference' }],
      ['LinkCard', { url: 'https://example.com/article', title: 'Reference', image: url }],
      ['Image', { url, alt: '照片' }],
      ['MediaCard', { url, alt: '照片', title: '参考' }],
      ['Gallery', { items: [{ url, alt: '照片' }] }],
    ] as const) {
      const source = JSON.stringify({
        root: 'link',
        elements: { link: { type, props, children: [] } },
        state: {},
      });
      assert.equal(parseRichSpec(source) !== null, valid, `${type}: ${url}`);
    }
  });
}

type Schema = {
  $ref?: string;
  $defs?: Record<string, Schema>;
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean';
  enum?: unknown[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  not?: { enum: string[] };
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
};
const catalog = JSON.parse(readFileSync(new URL('../../src/wandrun/gateway/ui_catalog.json', import.meta.url), 'utf8')) as {
  $defs: Record<string, Schema>;
  components: Record<string, { description: string; props: Schema; container: boolean; input?: { kind: string; value: Schema; allowEmpty?: boolean };
    relations?: ({ items: string; member?: string; lengthEquals: string } | { prop: string; lengthEquals: string } | { childrenLengthEquals: string })[] }>;
};
const definitions: Record<string, Schema> = { ...catalog.$defs };
for (const component of Object.values(catalog.components)) Object.assign(definitions, component.props.$defs);
type Path = (string | number)[];

function resolve(schema: Schema): Schema {
  return schema.$ref ? resolve(definitions[schema.$ref.replace('#/$defs/', '')]) : schema;
}

function sample(schema: Schema, path: Path = [], index = 0): unknown {
  schema = resolve(schema);
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return sample(schema.oneOf[0], path, index);
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {})
    .map(([name, property]) => [name, sample(property, [...path, name], index)]));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, (_, i) => sample(schema.items!, [...path, i], i));
  if (schema.type === 'string') {
    if (path.at(-1) === 'url' || path.at(-1) === 'image') return 'https://example.com/source';
    if (path.at(-1) === 'icon' || path.length === 1 && path[0] === 'name') return 'circle-check';
    return path.at(-1) === 'stateKey' ? 'field' : path.at(-1) === 'value' && path.includes('options') ? `option${index}` : 'x';
  }
  if (schema.type === 'number') return schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : schema.minimum ?? 0;
  if (schema.type === 'boolean') return false;
  throw new Error(`Unsupported catalog schema at ${path.join('.')}`);
}

function replaced(props: unknown, path: Path, value: unknown): unknown {
  if (!path.length) return value;
  const copy = structuredClone(props) as Record<string, unknown>;
  let parent: Record<string | number, unknown> = copy;
  for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
  parent[path.at(-1)!] = value;
  return copy;
}

// The catalog, not a hand-maintained list of fields or limits, drives each positive
// and negative case. Adding a schema keyword must extend this comparison explicitly.
test('every catalog component prop schema matches defensive App parsing at each field boundary', () => {
  assert.deepEqual(Object.keys(componentSchemas).sort(), Object.keys(catalog.components).sort());
  for (const [name, component] of Object.entries(catalog.components)) {
    const parser = componentSchemas[name as keyof typeof componentSchemas];
    const base = sample(component.props);
    const check = (props: unknown, accepted: boolean, where: string) => {
      assert.equal(parser.safeParse(props).success, accepted, `${name}.${where}`);
    };
    check(base, true, 'base');
    const walk = (unresolved: Schema, path: Path, context: unknown): void => {
      const schema = resolve(unresolved);
      const supported = ['$defs', 'type', 'enum', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'minLength', 'maxLength', 'pattern', 'not', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum'];
      assert.deepEqual(Object.keys(schema).filter((key) => !supported.includes(key)), [], `${name}.${path.join('.')}: unknown schema keyword`);
      const put = (value: unknown, accepted: boolean, caseName: string) => check(replaced(context, path, value), accepted, `${path.join('.')}.${caseName}`);
      const at = path.reduce<unknown>((value, part) => (value as Record<string | number, unknown>)[part], context);
      if (schema.oneOf) {
        for (const [i, branch] of schema.oneOf.entries()) {
          const alternative = replaced(context, path, sample(branch, path));
          check(alternative, true, `${path.join('.')}.branch${i}`);
          walk(branch, path, alternative);
        }
        put(false, false, 'unknown branch');
        return;
      }
      if (schema.enum) {
        for (const value of schema.enum) put(value, true, `enum ${String(value)}`);
        put('invalid_enum', false, 'unknown enum');
        return;
      }
      if (schema.type === 'object') {
        put(null, false, 'object type');
        if (schema.additionalProperties === false) put({ ...(at as object), unexpected: true }, false, 'extra field');
        for (const required of schema.required ?? []) {
          const without = structuredClone(at) as Record<string, unknown>;
          delete without[required];
          put(without, false, `missing ${required}`);
        }
        for (const [field, nested] of Object.entries(schema.properties ?? {})) walk(nested, [...path, field], context);
      } else if (schema.type === 'array') {
        put('not an array', false, 'array type');
        if (schema.minItems !== undefined && schema.minItems > 0)
          put(Array.from({ length: schema.minItems - 1 }, (_, i) => sample(schema.items!, [...path, i], i)), false, 'too few');
        if (schema.maxItems !== undefined) {
          put(Array.from({ length: schema.maxItems }, (_, i) => sample(schema.items!, [...path, i], i)), true, 'maximum items');
          put(Array.from({ length: schema.maxItems + 1 }, (_, i) => sample(schema.items!, [...path, i], i)), false, 'too many');
        }
        if (schema.items) {
          const items = at as unknown[];
          const withItem = items.length ? context : replaced(context, path, [sample(schema.items, [...path, 0])]);
          walk(schema.items, [...path, 0], withItem);
        }
        if (schema.uniqueItems) {
          const first = sample(schema.items!, [...path, 0]);
          put([first, first], false, 'duplicate items');
        }
      } else if (schema.type === 'string') {
        put(42, false, 'string type');
        if (schema.maxLength !== undefined) {
          const prefix = 'https://example.org/';
          const value = path.at(-1) === 'url' || path.at(-1) === 'image' ? prefix + 'x'.repeat(schema.maxLength - prefix.length) : '🧪'.repeat(schema.maxLength);
          put(value, true, 'unicode at max codepoints');
          put(`${value}🧪`, false, 'unicode over max codepoints');
        }
        if (schema.minLength !== undefined) {
          if (path.at(-1) !== 'url' && path.at(-1) !== 'image') put('x'.repeat(schema.minLength), true, 'minimum length');
          if (schema.minLength > 0) put('', false, 'empty value');
        }
        if (schema.pattern && path.at(-1) === 'stateKey') {
          put('_A9', true, 'identifier pattern');
          for (const invalid of ['', '9field', 'bad-key', 'é', 'x'.repeat(65), ...(schema.not?.enum ?? [])]) put(invalid, false, `invalid identifier ${invalid}`);
        }
      } else if (schema.type === 'number') {
        put('0', false, 'number type');
        if (schema.minimum !== undefined) {
          put(schema.minimum, true, 'minimum');
          put(schema.minimum - 1, false, 'below minimum');
        }
        if (schema.maximum !== undefined) {
          put(schema.maximum, true, 'maximum');
          put(schema.maximum + 1, false, 'above maximum');
        }
        if (schema.exclusiveMinimum !== undefined) {
          put(schema.exclusiveMinimum, false, 'exclusive minimum');
          put(schema.exclusiveMinimum + 0.1, true, 'above exclusive minimum');
        }
        for (const invalid of [Infinity, -Infinity, NaN]) put(invalid, false, 'non-finite');
      } else if (schema.type === 'boolean') put('false', false, 'boolean type');
    };
    walk(component.props, [], base);
  }
});

test('catalog relations and containers match App tree acceptance, including inner array lengths', () => {
  for (const [name, component] of Object.entries(catalog.components)) {
    if (component.input || name === 'Submit') continue;
    const props = sample(component.props) as Record<string, unknown>;
    for (const relation of component.relations ?? []) {
      if ('items' in relation) {
        const itemSchema = resolve(resolve(component.props).properties![relation.items]).items!;
        const arraySchema = relation.member ? resolve(itemSchema).properties![relation.member] : itemSchema;
        const expected = (props[relation.lengthEquals] as unknown[]).length;
        props[relation.items] = (props[relation.items] as unknown[]).map((item) => {
          const values = Array.from({ length: expected }, (_, index) => sample(resolve(arraySchema).items!, [], index));
          return relation.member ? { ...item as object, [relation.member]: values } : values;
        });
      } else if ('prop' in relation) {
        const memberSchema = resolve(component.props).properties![relation.prop].items!;
        props[relation.prop] = Array.from({ length: (props[relation.lengthEquals] as unknown[]).length },
          (_, index) => sample(memberSchema, [], index));
      }
    }
    const children = component.relations?.find((relation) => 'childrenLengthEquals' in relation);
    const count = children && 'childrenLengthEquals' in children
      ? (props[children.childrenLengthEquals] as unknown[]).length : component.container ? 1 : 0;
    const ids = Array.from({ length: count }, (_, index) => `child${index}`);
    const spec: { root: string; elements: Record<string, { type: string; props: Record<string, unknown>; children: string[] }>; state: Record<string, unknown> } = {
      root: 'root',
      elements: { root: { type: name, props, children: ids },
        ...Object.fromEntries(ids.map((id) => [id, { type: 'Text', props: { text: id }, children: [] }])) },
      state: {},
    };
    const check = (expected: boolean, reason: string) =>
      assert.equal(parseRichSpec(JSON.stringify(spec)) !== null, expected, `${name}: ${reason}`);
    check(true, 'baseline');
    if (!component.container) {
      spec.elements.root.children = ['child0'];
      spec.elements.child0 = { type: 'Text', props: { text: 'child0' }, children: [] };
      check(false, 'leaf rejects children');
      delete spec.elements.child0;
      spec.elements.root.children = ids;
    }
    for (const relation of component.relations ?? []) {
      if ('childrenLengthEquals' in relation) {
        const removed = spec.elements[ids[0]];
        spec.elements.root.children = ids.slice(1);
        delete spec.elements[ids[0]];
        check(false, 'one missing child');
        spec.elements[ids[0]] = removed;
        spec.elements.root.children = ids;
      } else if ('items' in relation) {
        const items = props[relation.items] as unknown[];
        const itemSchema = resolve(resolve(component.props).properties![relation.items]).items!;
        const arraySchema = relation.member ? resolve(itemSchema).properties![relation.member] : itemSchema;
        const original = relation.member ? (items[0] as Record<string, unknown>)[relation.member] as unknown[] : items[0] as unknown[];
        const set = (values: unknown[]) => {
          if (relation.member) (items[0] as Record<string, unknown>)[relation.member] = values;
          else items[0] = values;
        };
        set(original.slice(1));
        check(false, 'one missing nested value');
        set([...original, sample(resolve(arraySchema).items!)]);
        check(false, 'one extra nested value');
        set(original);
      } else {
        const original = props[relation.prop] as unknown[];
        const memberSchema = resolve(component.props).properties![relation.prop].items!;
        props[relation.prop] = original.slice(1);
        check(false, 'one missing value');
        props[relation.prop] = [...original, sample(memberSchema)];
        check(false, 'one extra value');
        props[relation.prop] = original;
      }
    }
  }
});

test('Stack accepts start and between and rejects unsupported justification values', () => {
  const stack = (props: Record<string, unknown>) => JSON.stringify({
    root: 'r', elements: { r: { type: 'Stack', props, children: [] } }, state: {},
  });
  for (const props of [{}, { justify: 'start' }, { justify: 'between', direction: 'horizontal', gap: 'sm' }]) {
    const parsed = parseRichSpec(stack(props));
    assert.ok(parsed, JSON.stringify(props));
    assert.deepEqual(parsed.elements.r.props, props);
  }
  for (const justify of ['end', 'space-between', 1, null]) {
    assert.equal(parseRichSpec(stack({ justify })), null, String(justify));
  }
});

test('finite extremes remain legal wire data, while chart relations still reject mismatches', () => {
  const chart = (type: string, props: Record<string, unknown>) => JSON.stringify({
    root: 'root', elements: { root: { type, props, children: [] } }, state: {},
  });
  assert.ok(parseRichSpec(chart('LineChart', {
    xLabels: ['start', 'end'], series: [{ name: 'range', values: [-1e308, 1e308] }],
  })));
  assert.ok(parseRichSpec(chart('BarChart', { labels: ['large'], values: [1e308] })));
  assert.ok(parseRichSpec(chart('PieChart', {
    items: [{ label: 'first', value: 1e308 }, { label: 'second', value: 1e308 }],
  })));
  assert.equal(parseRichSpec(chart('PieChart', {
    items: [{ label: 'zero', value: 0 }, { label: 'other', value: 1 }],
  })), null);
});

test('catalog input value schemas match App spec acceptance', () => {
  for (const [name, component] of Object.entries(catalog.components)) {
    if (!component.input || name === 'Submit') continue;
    const props = sample(component.props) as Record<string, unknown>;
    const key = props.stateKey as string;
    const options = props.options as { value: string }[] | undefined;
    const initial = component.input.kind === 'multiple' ? [] :
      component.input.kind === 'switch' ? false :
      component.input.kind === 'slider' ? props.min : '';
    const state: Record<string, unknown> = { [key]: initial };
    const spec = {
      root: 'card',
      elements: {
        card: { type: 'Card', props: {}, children: ['field', 'submit'] },
        field: { type: name, props, children: [] },
        submit: { type: 'Submit', props: { label: '提交' }, children: [] },
      },
      state,
    };
    const accepts = (value: unknown, accepted: boolean, reason: string) => {
      spec.state[key] = value;
      assert.equal(parseRichSpec(JSON.stringify(spec)) !== null, accepted, `${name}: ${reason}`);
    };
    accepts(initial, true, 'baseline');
    const schema = component.input.value;
    const supported = ['type', 'maxLength', 'pattern', 'uniqueItems', 'items'];
    assert.deepEqual(Object.keys(schema).filter((word) => !supported.includes(word)), [], `${name}: unknown value constraint`);
    switch (component.input.kind) {
      case 'choice':
        assert.equal(schema.type, 'string');
        accepts(options![0].value, true, 'listed option');
        accepts('not-listed', false, 'unknown option');
        accepts('', component.input.allowEmpty === true, 'empty selection');
        accepts(3, false, 'wrong value type');
        break;
      case 'multiple':
        assert.equal(schema.type, 'array');
        assert.equal(schema.uniqueItems, true);
        assert.equal(schema.items?.type, 'string');
        accepts([options![0].value, options![1].value], true, 'two selections');
        accepts([options![0].value, options![0].value], false, 'repeated selection');
        accepts(['not-listed'], false, 'unknown option');
        accepts([42], false, 'wrong item type');
        break;
      case 'switch':
        assert.equal(schema.type, 'boolean');
        accepts(true, true, 'enabled');
        accepts('true', false, 'wrong value type');
        break;
      case 'slider':
        assert.equal(schema.type, 'number');
        spec.elements.field.props = { ...props, max: 2, step: 0.5 };
        accepts(1.5, true, 'decimal grid');
        accepts(1.6, false, 'off-grid');
        accepts(3, false, 'out of range');
        accepts('1.5', false, 'wrong value type');
        break;
      case 'text':
        assert.equal(schema.type, 'string');
        assert.ok(schema.maxLength !== undefined);
        accepts('🧪'.repeat(schema.maxLength), true, 'Unicode codepoint limit');
        accepts('🧪'.repeat(schema.maxLength + 1), false, 'Unicode over limit');
        accepts(1, false, 'wrong value type');
        break;
      case 'date':
        assert.equal(schema.type, 'string');
        assert.ok(schema.pattern);
        accepts('2024-02-29', true, 'valid leap day');
        accepts('2024-02-30', false, 'nonexistent day');
        accepts('2024/02/29', false, 'invalid pattern');
        break;
      default:
        assert.fail(`${name}: unknown catalog input kind ${component.input.kind}`);
    }
  }
});

test('media sources are exclusive, URL delivery is syntax-only, and bounds cover nested gallery items', () => {
  const image = componentSchemas.Image;
  for (const url of ['https://images.example.org/p.png?sig=abc', 'http://localhost/private.png']) {
    assert.equal(image.safeParse({ url, alt: '照片' }).success, true);
  }
  for (const url of ['file:///private.png', 'https://user:secret@example.org/photo', 'https://@example.org/photo', 'https://example.org:0/photo', 'https://', 'https:\\\\example.org\\photo.png']) {
    assert.equal(image.safeParse({ url, alt: '照片' }).success, false);
  }
  assert.equal(image.safeParse({ attachment: 'photo.png', url: 'https://example.org/photo', alt: '照片' }).success, false);
  assert.equal(componentSchemas.MediaCard.safeParse({ attachment: 'photo.png', alt: '照片', title: 'x' }).success, true);
  assert.equal(componentSchemas.Gallery.safeParse({ items: Array.from({ length: 8 }, (_, i) => ({ attachment: `${i}.jpg`, alt: String(i) })) }).success, true);
  assert.equal(componentSchemas.Gallery.safeParse({ items: Array.from({ length: 9 }, (_, i) => ({ attachment: `${i}.jpg`, alt: String(i) })) }).success, false);
  assert.equal(componentSchemas.Mermaid.safeParse({ source: 'flowchart LR\\n A --> B' }).success, true);
  assert.equal(componentSchemas.Mermaid.safeParse({ source: '' }).success, false);
});

test('message media requests use only encoded persisted coordinates and preserve classified errors', async () => {
  const calls: { path: string; authorization: string | null }[] = [];
  const api = new GatewayApi({ baseUrl: 'https://gateway.test/', token: 'secret' }, async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname + url.search, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.pathname.endsWith('/content')) return new Response('PNG', { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname.includes('/markdown/')) return Response.json({ error: { code: 'unsafe_media_address', message: '图片地址不可访问' } }, { status: 400 });
    return Response.json({ mime: 'image/png', width: 320, height: 180 });
  });
  assert.deepEqual(await api.getMessageMedia('space/id', 8, 2, 'image_one', 0), { mime: 'image/png', width: 320, height: 180 });
  assert.equal(api.mediaContentPath('space/id', 8, 2, 'image_one', 0), '/conversations/space%2Fid/messages/8/media/2/image_one/0/content');
  await assert.rejects(api.getMessageMedia('space/id', 8, 'markdown', 'image', 3),
    (error: unknown) => error instanceof GatewayError && error.code === 'unsafe_media_address');
  assert.deepEqual(calls, [
    { path: '/conversations/space%2Fid/messages/8/media/2/image_one/0', authorization: 'Bearer secret' },
    { path: '/conversations/space%2Fid/messages/8/media/markdown/image/3', authorization: 'Bearer secret' },
  ]);
});
