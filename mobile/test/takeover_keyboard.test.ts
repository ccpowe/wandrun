// 键盘与输入法：差分算法（input-buffer.ts）与特殊键映射表（keys.ts）。node --test test/

import assert from "node:assert/strict";
import { test } from "node:test";

import { diffText, InputBuffer, type InputOp } from "../src/takeover-lab/input-buffer.ts";
import { HELPER_KEYS, KEYS } from "../src/takeover-lab/keys.ts";

const text = (value: string): InputOp => ({ kind: "text", text: value });
const key = (name: InputOp extends infer O ? (O extends { kind: "key"; key: infer K } ? K : never) : never): InputOp => ({ kind: "key", key: name });

function collect(buffer: InputBuffer, method: "flush" | "enter" | "backspace" = "flush") {
  const ops: InputOp[] = [];
  assert.equal(buffer[method]((op) => { ops.push(op); return true; }), true);
  return ops;
}

test("diff：追加只新增，不重发已有的字", () => {
  assert.deepEqual(diffText("ab", "abc"), { deleted: 0, inserted: "c" });
  assert.deepEqual(diffText("", "你好"), { deleted: 0, inserted: "你好" });
});

test("diff：删除与替换（组字中间态被成字替换）", () => {
  assert.deepEqual(diffText("abc", "ab"), { deleted: 1, inserted: "" });
  assert.deepEqual(diffText("ni", "你"), { deleted: 2, inserted: "你" });
  assert.deepEqual(diffText("你ni", "你你"), { deleted: 2, inserted: "你" });
});

test("diff：中间插入——只用前缀，让远端（光标在末尾）最终与输入框一致", () => {
  assert.deepEqual(diffText("abc", "abXc"), { deleted: 1, inserted: "Xc" });
});

test("diff：emoji 按码点计，不拆代理对", () => {
  assert.deepEqual(diffText("a😀", "a"), { deleted: 1, inserted: "" });
  assert.deepEqual(diffText("a", "a😀😀"), { deleted: 0, inserted: "😀😀" });
  assert.deepEqual(diffText("😀", "😁"), { deleted: 1, inserted: "😁" });
});

test("缓冲：组字中间态合并成一次提交（settle 模式下只在静止后 flush）", () => {
  const buffer = new InputBuffer();
  // 拼音 n → ni → nih → nihao → 选词“你好”，期间都没有 flush
  for (const t of ["n", "ni", "nih", "nihao", "你好"]) buffer.change(t);
  assert.deepEqual(collect(buffer), [text("你好")]);
});

test("缓冲：中间态已发出（immediate 或超时）时，之后的替换先退格再插入，最终仍正确", () => {
  const buffer = new InputBuffer();
  buffer.change("ni");
  assert.deepEqual(collect(buffer), [text("ni")]);
  buffer.change("你");
  assert.deepEqual(collect(buffer), [key("Backspace"), key("Backspace"), text("你")]);
});

test("缓冲：连续输入每次只发新增部分；没变化不发", () => {
  const buffer = new InputBuffer();
  buffer.change("你好");
  assert.deepEqual(collect(buffer), [text("你好")]);
  assert.equal(buffer.change("你好"), false);
  assert.deepEqual(collect(buffer), []);
  buffer.change("你好吗");
  assert.deepEqual(collect(buffer), [text("吗")]);
});

test("缓冲：取消组字（组字文字被删回原样）不产生任何操作", () => {
  const buffer = new InputBuffer();
  buffer.change("你好");
  collect(buffer);
  for (const t of ["你好n", "你好ni", "你好"]) buffer.change(t);
  assert.deepEqual(collect(buffer), []);
});

test("退格：输入框有字时由差分负责（onKeyPress 不重复发）；输入框空时才转成远端 Backspace", () => {
  const buffer = new InputBuffer();
  buffer.change("ab");
  collect(buffer);
  assert.deepEqual(collect(buffer, "backspace"), []); // onKeyPress 先到，输入框还是 "ab"
  buffer.change("a");
  assert.deepEqual(collect(buffer), [key("Backspace")]);
  assert.deepEqual(collect(buffer, "backspace"), []);
  buffer.change("");
  assert.deepEqual(collect(buffer), [key("Backspace")]);
  assert.deepEqual(collect(buffer, "backspace"), [key("Backspace")]); // 已空：删远端已有的字
});

test("退格：输入框空但还有未发送的退格时，保持顺序", () => {
  const buffer = new InputBuffer();
  buffer.change("ab");
  collect(buffer);
  buffer.change("");
  assert.deepEqual(collect(buffer, "backspace"), [key("Backspace"), key("Backspace"), key("Backspace")]);
});

test("Enter：先提交未发送的文字，再发 Enter", () => {
  const buffer = new InputBuffer();
  buffer.change("你好");
  assert.deepEqual(collect(buffer, "enter"), [text("你好"), key("Enter")]);
  assert.deepEqual(collect(buffer, "enter"), [key("Enter")]);
});

test("缓冲超限：flush 后重置并要求清空输入框，之后继续从空缓冲开始", () => {
  const buffer = new InputBuffer(3);
  buffer.change("abcd");
  assert.deepEqual(collect(buffer), [text("abcd")]);
  assert.equal(buffer.needsClear, true);
  buffer.change(""); // 清空本身的 onChangeText("")：不能被当成删除
  assert.deepEqual(collect(buffer), []);
  buffer.change("e");
  assert.deepEqual(collect(buffer), [text("e")]);
});


test("按键映射表：key/code/虚拟键码正确，只有 Enter 带 text", () => {
  assert.deepEqual(KEYS.Enter, { key: "Enter", code: "Enter", vk: 13, text: "\r" });
  assert.deepEqual(KEYS.Backspace, { key: "Backspace", code: "Backspace", vk: 8 });
  assert.equal(KEYS.Tab.vk, 9);
  assert.equal(KEYS.Escape.vk, 27);
  assert.deepEqual([KEYS.ArrowLeft.vk, KEYS.ArrowUp.vk, KEYS.ArrowRight.vk, KEYS.ArrowDown.vk], [37, 38, 39, 40]);
  for (const [name, descriptor] of Object.entries(KEYS)) {
    assert.equal(descriptor.key, name);
    assert.equal(descriptor.code, name);
    if (name !== "Enter") assert.equal(descriptor.text, undefined);
  }
});

test("辅助键行：Tab Esc ← → ↑ ↓", () => {
  assert.deepEqual(HELPER_KEYS.map((k) => k.label), ["Tab", "Esc", "←", "→", "↑", "↓"]);
  for (const { name } of HELPER_KEYS) assert.ok(name in KEYS);
});

test("rejected insertion does not clear an oversized buffer or allow Enter to overtake it", () => {
  const buffer = new InputBuffer(3);
  buffer.change("你好世界");
  assert.equal(buffer.enter(() => false), false);
  assert.equal(buffer.needsClear, false);
  assert.deepEqual(collect(buffer, "enter"), [text("你好世界"), key("Enter")]);
  assert.equal(buffer.needsClear, true);
});

test("partial replacement resumes after accepted Unicode backspaces without deleting twice", () => {
  const buffer = new InputBuffer();
  buffer.change("a😀b");
  collect(buffer);
  buffer.change("你");
  let attempts = 0;
  assert.equal(buffer.flush(() => ++attempts < 3), false);
  assert.deepEqual(collect(buffer), [key("Backspace"), text("你")]);
  assert.deepEqual(collect(buffer), []);
});
