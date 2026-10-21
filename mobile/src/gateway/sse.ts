// SSE 文本解析（WHATWG 事件流格式的子集）。RN 没有 EventSource，事件流用 fetch 的流式响应自己读，
// 所以 Last-Event-ID、重连都由 EventStream 自己管，这里只把字节切成事件。

export type SseMessage = { id: string | null; event: string; data: string };

export class SseParser {
  private buffer = "";
  private id: string | null = null;
  private event = "";
  private data: string[] = [];

  /** 喂入一段文本，返回其中完整的事件；不完整的行留到下一段。注释行（心跳）返回为 event=":"。 */
  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      // \r 是最后一个字符时可能还有 \n 没到，留着下次再切，避免把 \r\n 当成两个空行。
      if (this.buffer[newline] === "\r" && newline === this.buffer.length - 1) break;
      this.buffer = this.buffer.slice(newline + (this.buffer.startsWith("\r\n", newline) ? 2 : 1));
      if (line === "") {
        if (this.data.length > 0 || this.event) {
          messages.push({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
        }
        this.id = null;
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) {
        messages.push({ id: null, event: ":", data: line.slice(1).trim() });
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "event") this.event = value;
      else if (field === "id") this.id = value;
    }
    return messages;
  }
}
