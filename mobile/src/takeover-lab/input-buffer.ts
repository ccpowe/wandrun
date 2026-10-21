// 隐藏输入框的文字提交策略：本地输入框只当“输入法的缓冲”，远端是它的镜像。
// 维护 sent（已交给连接发送的镜像，不代表远端确认）与 current（输入框现在的文字）。flush 时按公共前缀做差分：
//   删除数 = sent 在公共前缀之后的码点数  → 逐个 Backspace 按键
//   新增文本 = current 在公共前缀之后的部分 → 一次 Input.insertText
// 只用前缀、不用后缀：远端插入点（光标）永远在镜像末尾，输入框中间改动时 前缀差分才让两边最终一致。
// 组字中间态（拼音字母先写进输入框，成字后被替换）因此是“自愈”的：即使中间态被发出去，
// 之后的替换会先退格再插入，最终字符仍正确；COMMIT 选项只决定是否抑制这些中间态（见 COMMIT）。

import type { KeyName } from "./keys.ts";

export type InputOp = { kind: "text"; text: string } | { kind: "key"; key: KeyName };

export type CommitOptions = {
  /**
   * settle：文字变化后静止 settleMs 才发送（拼音组字期间连续变化，通常合并为成字后的一次提交）；
   * immediate：每次变化立刻发送（延迟最低，但组字中间态会先出现在远端再被替换）。
   */
  mode: "settle" | "immediate";
  settleMs: number;
  /** 缓冲超过这么多码点就在 flush 后清空，避免无限增长；清空发生在静止之后，不会打断正在进行的组字。 */
  maxBuffer: number;
};

// A/B 选项集中在这里，真机上改这一处即可。
export const COMMIT: CommitOptions = { mode: "settle", settleMs: 350, maxBuffer: 200 };

/** 码点序列（避免把 emoji 的代理对拆开）。 */
const points = (text: string): string[] => Array.from(text);

export function diffText(sent: string, current: string): { deleted: number; inserted: string } {
  const a = points(sent);
  const b = points(current);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return { deleted: a.length - prefix, inserted: b.slice(prefix).join("") };
}

export class InputBuffer {
  private sent = "";
  private current = "";
  /** 上一次 flush 之后缓冲超限，调用方应清空输入框（buffer 已重置为空）。 */
  needsClear = false;

  private readonly maxBuffer: number;

  constructor(maxBuffer: number = COMMIT.maxBuffer) {
    this.maxBuffer = maxBuffer;
  }

  /** 未被连接接受的文字差分；不包含已接受但尚未收到远端回执的操作。 */
  get hasPending(): boolean { return this.current !== this.sent; }

  /** 输入框文字变了（onChangeText）。返回是否有尚未发送的差异。 */
  change(text: string): boolean {
    this.current = text;
    return this.hasPending;
  }

  /** 逐操作提交差分；发送拒绝即停止，保留未发送部分，不能重放已接受的退格。 */
  flush(send: (op: InputOp) => boolean): boolean {
    const { deleted, inserted } = diffText(this.sent, this.current);
    const sent = points(this.sent);
    for (let i = 0; i < deleted; i++) {
      if (!send({ kind: "key", key: "Backspace" })) return false;
      sent.pop();
      this.sent = sent.join("");
    }
    if (inserted) {
      if (!send({ kind: "text", text: inserted })) return false;
      this.sent = this.current;
    }
    if (points(this.current).length > this.maxBuffer) {
      this.sent = this.current = "";
      this.needsClear = true;
    }
    return true;
  }

  /**
   * onKeyPress 收到 Backspace（它先于 onChangeText 触发）。输入框里有字时删除会随后体现为文字变化，
   * 由 flush 的差分负责；只有输入框已空（没有东西可删）时，才把它转成远端的 Backspace。
   * 先 flush，保证与尚未发送的退格保持顺序。
   */
  backspace(send: (op: InputOp) => boolean): boolean {
    if (this.current !== "") return true;
    return this.flush(send) && send({ kind: "key", key: "Backspace" });
  }

  /** Enter：先提交缓冲里未发送的文字，再发 Enter。 */
  enter(send: (op: InputOp) => boolean): boolean {
    return this.flush(send) && send({ kind: "key", key: "Enter" });
  }

  /** 丢弃镜像关系，不改远端内容；返回是否丢弃了未发送的差异，供界面提示重新输入。 */
  reset(): boolean {
    const discarded = this.hasPending;
    this.sent = this.current = "";
    this.needsClear = false;
    return discarded;
  }
}

