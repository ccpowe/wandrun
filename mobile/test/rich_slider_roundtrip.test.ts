import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { alignedSliderValue, parseRichSpec, submissionValues } from '../src/components/rich-message/spec.ts';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const python = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));

function sliderSpec(min: number, max: number, step: number, value: number) {
  return { root: 'card', elements: {
    card: { type: 'Card', props: {}, children: ['slider', 'submit'] },
    slider: { type: 'Slider', props: { stateKey: 'value', label: '数值', min, max, step }, children: [] },
    submit: { type: 'Submit', props: { label: '提交' }, children: [] },
  }, state: { value } };
}

test('native slider decimal normalization survives JSON serialization and Python validate_values', () => {
  const cases = [
    { min: 0, max: 1, step: 0.1, raw: 0.30000001192092896, expected: 0.3 },
    { min: 0.1, max: 1.1, step: 0.2, raw: 0.699999988079071, expected: 0.7 },
    { min: 0.2, max: 1.2, step: 0.3333333333333333, raw: 0.8666666666666667, expected: 0.8666666666666666 },
    { min: 1.125, max: 2.5, step: 0.3333333333333333, raw: 1.7916666269302368, expected: 1.7916666666666666 },
    { min: 0.1234567890123456, max: 1.5, step: 0.3333333333333333, raw: 0.4567901223456789, expected: 0.4567901223456789 },
    // The exact grid point .45679012234567896 rounds to this JS number, not min.
    { min: 0.12345678901234566, max: 1.5, step: 0.3333333333333333, raw: 0.456790122345679, expected: 0.45679012234567895 },
    // JSON serializes this projected point as integer 1; Python receives an int.
    { min: 0.9999999999999999, max: 1, step: 0.00000000000000009, raw: 1, expected: 1 },
    { min: -0.2, max: 0.8, step: 0.1, raw: 0.7000000476837158, expected: 0.7 },
    { min: 0, max: 1, step: 0.1, raw: 1, expected: 1 },
    { min: 1, max: 1, step: 0.1, raw: 1, expected: 1 },
  ];
  const payload = cases.map(({ min, max, step, raw, expected }) => {
    const spec = sliderSpec(min, max, step, min);
    const parsed = parseRichSpec(JSON.stringify(spec));
    assert.ok(parsed, `initial slider ${min}/${step}`);
    const normalized = alignedSliderValue(min, max, step, raw);
    assert.equal(normalized, expected, `${min}/${step}`);
    const values = submissionValues(parsed, { value: normalized });
    return { spec, values };
  });
  const program = `
import json, sys
sys.path.insert(0, 'src')
from wandrun.gateway.ui_blocks import parse_blocks, validate_values
result = []
for case in json.load(sys.stdin):
    text = chr(96) * 3 + 'wandrun-ui\\n' + json.dumps(case['spec'], ensure_ascii=False) + '\\n' + chr(96) * 3
    blocks = parse_blocks(text)
    assert len(blocks) == 1 and blocks[0].spec is not None, blocks
    result.append(validate_values(blocks[0].spec, case['values']))
json.dump(result, sys.stdout, ensure_ascii=False)
`;
  const bridge = spawnSync(python, ['-c', program], { cwd: workspace, input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.deepEqual(JSON.parse(bridge.stdout), cases.map(() => ({})));
  assert.equal(parseRichSpec(JSON.stringify(sliderSpec(0, 1, 0.1, 0.30000000000000004))), null);
  assert.equal(parseRichSpec(JSON.stringify(sliderSpec(0, 1, 0.3333333333333333, 0.666666666666667))), null);
});
