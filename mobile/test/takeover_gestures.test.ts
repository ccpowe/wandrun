// 触控模式手势识别：node --test test/

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Action, type TouchEvent, TouchModeRecognizer } from "../src/takeover-lab/gestures.ts";

type P = [number, number];
const finger = (id: number | string, [x, y]: P) => ({ id: String(id), x, y });

function run(events: TouchEvent[]): Action[] {
  const recognizer = new TouchModeRecognizer();
  return events.flatMap((event) => recognizer.handle(event));
}

test("单指按下抬起：在抬起位置发一次左键点击", () => {
  const actions = run([
    { type: "start", touches: [finger(1, [100, 200])], t: 0 },
    { type: "end", touches: [], t: 80 },
  ]);
  assert.deepEqual(actions, [{ kind: "click", button: "left", x: 100, y: 200 }]);
});

test("位移在 10dp 之内的抖动仍是点击，用最后位置", () => {
  const actions = run([
    { type: "start", touches: [finger(1, [100, 200])], t: 0 },
    { type: "move", touches: [finger(1, [104, 207])], t: 40 },
    { type: "end", touches: [], t: 90 },
  ]);
  assert.deepEqual(actions, [{ kind: "click", button: "left", x: 104, y: 207 }]);
});

test("位移超过 10dp 不是点击，拖回原处也不是", () => {
  const actions = run([
    { type: "start", touches: [finger(1, [100, 200])], t: 0 },
    { type: "move", touches: [finger(1, [100, 215])], t: 40 },
    { type: "move", touches: [finger(1, [100, 201])], t: 80 },
    { type: "end", touches: [], t: 120 },
  ]);
  assert.ok(actions.every((action) => action.kind === "pan"));
  assert.equal(actions.reduce((sum, action) => sum + (action.kind === "pan" ? action.dy : 0), 0), 1);
});

test("按住 500ms 及以上不是点击（长按由定时器 tick 触发）", () => {
  const slow = run([
    { type: "start", touches: [finger(1, [10, 10])], t: 0 },
    { type: "end", touches: [], t: 500 },
  ]);
  assert.deepEqual(slow, []);
  const quick = run([
    { type: "start", touches: [finger(1, [10, 10])], t: 0 },
    { type: "end", touches: [], t: 499 },
  ]);
  assert.equal(quick.length, 1);
});

test("第二指落下：取消第一指，两指抬起都不产生点击", () => {
  const actions = run([
    { type: "start", touches: [finger(1, [100, 200])], t: 0 },
    { type: "start", touches: [finger(1, [100, 200]), finger(2, [150, 200])], t: 30 },
    { type: "end", touches: [finger(1, [100, 200])], t: 60 },
    { type: "end", touches: [], t: 90 },
  ]);
  assert.deepEqual(actions, []);
});

test("双指结束后，在剩一指期间也不动作；全部抬起后下一次点击恢复正常", () => {
  const recognizer = new TouchModeRecognizer();
  const events: TouchEvent[] = [
    { type: "start", touches: [finger(1, [100, 200])], t: 0 },
    { type: "start", touches: [finger(1, [100, 200]), finger(2, [150, 200])], t: 30 },
    { type: "end", touches: [finger(2, [150, 200])], t: 60 },
    { type: "end", touches: [], t: 90 },
  ];
  assert.deepEqual(events.flatMap((event) => recognizer.handle(event)), []);
  const next = [
    { type: "start", touches: [finger(3, [40, 50])], t: 1000 },
    { type: "end", touches: [], t: 1050 },
  ] as TouchEvent[];
  assert.deepEqual(next.flatMap((event) => recognizer.handle(event)), [{ kind: "click", button: "left", x: 40, y: 50 }]);
});

test("按触点 id 跟踪，不依赖数组下标", () => {
  const actions = run([
    { type: "start", touches: [finger(7, [60, 60])], t: 0 },
    { type: "move", touches: [finger(9, [300, 300]), finger(7, [62, 61])], t: 20 },
    { type: "end", touches: [], t: 50 },
  ]);
  // 出现了别的触点（本应先有 start 事件）；移动里还找得到 7，所以只当抖动处理，不会用 9 的位置。
  assert.deepEqual(actions, [{ kind: "click", button: "left", x: 62, y: 61 }]);
});

test("系统取消（cancel）：没有点击，之后恢复", () => {
  const recognizer = new TouchModeRecognizer();
  const events: TouchEvent[] = [
    { type: "start", touches: [finger(1, [5, 5])], t: 0 },
    { type: "cancel", touches: [], t: 20 },
    { type: "end", touches: [], t: 40 },
    { type: "start", touches: [finger(2, [8, 9])], t: 100 },
    { type: "end", touches: [], t: 130 },
  ];
  assert.deepEqual(events.flatMap((event) => recognizer.handle(event)), [{ kind: "click", button: "left", x: 8, y: 9 }]);
});

test("跟踪的那一指在移动事件里消失：作废，不点击", () => {
  const actions = run([
    { type: "start", touches: [finger(1, [5, 5])], t: 0 },
    { type: "move", touches: [finger(2, [5, 5])], t: 20 },
    { type: "end", touches: [], t: 40 },
  ]);
  assert.deepEqual(actions, []);
});

test("长按：定时器到点在当前位置发右键，抬起不再点击", () => {
  const recognizer = new TouchModeRecognizer();
  assert.deepEqual(recognizer.handle({ type: "start", touches: [finger(1, [50, 60])], t: 0 }), []);
  recognizer.handle({ type: "move", touches: [finger(1, [55, 66])], t: 200 }); // 位移 ≤ 10dp
  assert.deepEqual(recognizer.tick(), [{ kind: "click", button: "right", x: 55, y: 66 }]);
  assert.deepEqual(recognizer.handle({ type: "end", touches: [], t: 700 }), []);
  assert.deepEqual(recognizer.tick(), []); // 之后的 tick 无效
});

test("长按前已拖动（超过 10dp）：tick 无效", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [50, 60])], t: 0 });
  recognizer.handle({ type: "move", touches: [finger(1, [50, 80])], t: 100 });
  assert.deepEqual(recognizer.tick(), []);
});

test("长按前抬起（点击）或第二指落下：tick 无效", () => {
  const a = new TouchModeRecognizer();
  a.handle({ type: "start", touches: [finger(1, [5, 5])], t: 0 });
  a.handle({ type: "end", touches: [], t: 100 });
  assert.deepEqual(a.tick(), []);
  const b = new TouchModeRecognizer();
  b.handle({ type: "start", touches: [finger(1, [5, 5])], t: 0 });
  b.handle({ type: "start", touches: [finger(1, [5, 5]), finger(2, [50, 5])], t: 100 });
  assert.deepEqual(b.tick(), []);
});

test("单指拖动 = 平移视角：超过 10dp 后发 pan，起始位移一并计入，之后逐次 1:1、不合并", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [100, 300])], t: 0 });
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(1, [100, 295])], t: 10 }), []);
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(1, [100, 280])], t: 11 }), [{ kind: "pan", dx: 0, dy: -20 }]);
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(1, [95, 270])], t: 12 }), [{ kind: "pan", dx: -5, dy: -10 }]);
  assert.deepEqual(recognizer.handle({ type: "end", touches: [], t: 20 }), []); // 抬起不点击、不补发
});

test("拖动不再发 wheel（滚网页只靠滚轮条）", () => {
  const actions = run([
    { type: "start", touches: [finger(1, [10, 10])], t: 0 },
    { type: "move", touches: [finger(1, [40, 60])], t: 30 },
    { type: "end", touches: [], t: 60 },
  ]);
  assert.ok(actions.length > 0 && actions.every((a) => a.kind === "pan"));
});

test("拖动中第二指落下：取消拖动，不再平移", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [0, 100])], t: 0 });
  recognizer.handle({ type: "move", touches: [finger(1, [0, 60])], t: 20 });
  recognizer.handle({ type: "start", touches: [finger(1, [0, 50]), finger(2, [80, 50])], t: 22 });
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(1, [0, 30]), finger(2, [80, 50])], t: 60 }), []);
  assert.deepEqual(recognizer.handle({ type: "end", touches: [finger(2, [80, 50])], t: 80 }), []);
  assert.deepEqual(recognizer.handle({ type: "end", touches: [], t: 90 }), []);
});

test("双指：距离变化不到 8dp 的抖动不缩放；超过后以当前为基线逐步发 pinch", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [100, 100])], t: 0 });
  recognizer.handle({ type: "start", touches: [finger(1, [100, 100]), finger(2, [200, 100])], t: 10 });
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(1, [98, 100]), finger(2, [202, 100])], t: 20 }), []); // 距离 +4
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(1, [90, 100]), finger(2, [210, 100])], t: 30 }), []); // 激活，基线 d=120
  const [action] = recognizer.handle({ type: "move", touches: [finger(1, [80, 100]), finger(2, [220, 100])], t: 40 });
  assert.deepEqual(action, { kind: "pinch", scale: 140 / 120, from: { x: 150, y: 100 }, to: { x: 150, y: 100 } });
});

test("双指平移：中点移动超过 8dp 后发 pinch，scale 为 1", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [100, 100]), finger(2, [200, 100])], t: 0 });
  recognizer.handle({ type: "move", touches: [finger(1, [100, 120]), finger(2, [200, 120])], t: 10 }); // 激活
  const actions = recognizer.handle({ type: "move", touches: [finger(1, [100, 150]), finger(2, [200, 150])], t: 20 });
  assert.deepEqual(actions, [{ kind: "pinch", scale: 1, from: { x: 150, y: 120 }, to: { x: 150, y: 150 } }]);
});

test("双指抬起一指后：剩下的手指不动作、不继续缩放；全部抬起后恢复", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [100, 100]), finger(2, [200, 100])], t: 0 });
  recognizer.handle({ type: "move", touches: [finger(1, [60, 100]), finger(2, [240, 100])], t: 10 });
  recognizer.handle({ type: "end", touches: [finger(2, [240, 100])], t: 20 });
  assert.deepEqual(recognizer.handle({ type: "move", touches: [finger(2, [300, 300])], t: 30 }), []);
  assert.deepEqual(recognizer.handle({ type: "end", touches: [], t: 40 }), []);
  const next = [
    { type: "start", touches: [finger(3, [7, 8])], t: 100 },
    { type: "end", touches: [], t: 120 },
  ] as TouchEvent[];
  assert.deepEqual(next.flatMap((event) => recognizer.handle(event)), [{ kind: "click", button: "left", x: 7, y: 8 }]);
});

test("双指期间第三指落下不改变状态", () => {
  const recognizer = new TouchModeRecognizer();
  recognizer.handle({ type: "start", touches: [finger(1, [100, 100]), finger(2, [200, 100])], t: 0 });
  recognizer.handle({ type: "start", touches: [finger(1, [100, 100]), finger(2, [200, 100]), finger(3, [0, 0])], t: 5 });
  recognizer.handle({ type: "move", touches: [finger(1, [60, 100]), finger(2, [240, 100]), finger(3, [0, 0])], t: 10 });
  const actions = recognizer.handle({ type: "move", touches: [finger(1, [40, 100]), finger(2, [260, 100]), finger(3, [0, 0])], t: 20 });
  assert.equal(actions.length, 1);
});
