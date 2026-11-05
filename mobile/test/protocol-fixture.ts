// L3 共用真实 Python/HTTP/SSE 夹具；重启与全局资源场景仍使用独占网关。
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, afterEach } from "node:test";

import { GatewayApi, type GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";

const root = path.resolve(import.meta.dirname, "..");
export const directory = mkdtempSync(path.join(tmpdir(), "wandrun-mobile-"));
const running = new Set<ChildProcess>();
export const sessions = new Set<ChatSession>();
let shared: StubGateway | undefined;

// 先关客户端，避免清理时的事件或失败触发后台重连；共享组不复用会话数据。
afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
  for (const child of running) child.kill("SIGKILL");
  if (shared) {
    const api = new GatewayApi({ baseUrl: shared.url, token: "dev" });
    for (const conversation of (await api.listConversations()).conversations) {
      if (conversation.status === "working") await api.stop(conversation.id, `cleanup-${conversation.id}`);
      await until(async () => (await api.listConversations()).conversations
        .every((item) => item.id !== conversation.id || item.status !== "working"));
      await api.deleteConversation(conversation.id);
    }
    assert.deepEqual((await api.listConversations()).conversations, []);
  }
});

after(async () => {
  if (shared) await shared.kill();
  for (const child of running) child.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
});

export class StubGateway {
  private boundPort = 0;
  get port(): number { return this.boundPort; }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  database = path.join(directory, `gateway-${randomUUID()}.sqlite`);
  private child: ChildProcess | null = null;

  private readonly browserStream: boolean;
  constructor(browserStream = false) { this.browserStream = browserStream; }

  /** Python 冷启动与 HTTP 就绪分别有界；只信任本次子进程绑定的端口。重启沿用原端口。 */
  async start(database = this.database): Promise<void> {
    this.database = database;
    // SIGKILL 必须杀到 Python 本身，不能只杀 uv 包装进程。
    const child = spawn(path.join(root, "../.venv/bin/python"), [
      "test/stub_gateway.py", database, String(this.port), ...(this.browserStream ? ["--browser-stream"] : []),
    ], {
      cwd: root, stdio: ["ignore", "pipe", "inherit"],
    });
    this.child = child;
    if (this !== shared) running.add(child);
    child.on("exit", () => running.delete(child));
    const announced = Promise.withResolvers<number>();
    const output = createInterface({ input: child.stdout });
    output.once("line", (line) => {
      const match = /^STUB_GATEWAY_PORT=(\d+)$/.exec(line);
      if (match) announced.resolve(Number(match[1]));
      else announced.reject(new Error(`Unexpected stub startup output: ${line}`));
    });
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      announced.reject(new Error(`Stub gateway exited: code=${code}, signal=${signal}`));
    child.once("error", announced.reject);
    child.once("exit", exited);
    // 高负载实测冷导入超过 30 秒；这不是网关 HTTP 的响应期限。
    const timer = setTimeout(() => announced.reject(new Error("Python bootstrap exceeded 60s")), 60_000);
    let phase = "Python bootstrap";
    try {
      this.boundPort = await announced.promise;
      clearTimeout(timer);
      phase = "HTTP readiness";
      const api = new GatewayApi({ baseUrl: this.url, token: "dev" });
      await until(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Stub gateway exited: code=${child.exitCode}, signal=${child.signalCode}`);
        }
        return api.listConversations().then(() => true, () => false);
      }, 30_000);
    } catch (error) {
      await this.kill();
      throw new Error(`Stub gateway ${phase} failed`, { cause: error });
    } finally {
      clearTimeout(timer);
      output.close();
      child.removeListener("error", announced.reject);
      child.removeListener("exit", exited);
    }
  }

  /** 模拟崩溃：不给网关收尾的机会。 */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
    await promise;
  }
}

/** 仅用于不改全局 Agent/配置、不重启的串行场景；命令 ID 须在组内唯一。 */
export async function sharedGateway(): Promise<StubGateway> {
  if (!shared) {
    shared = new StubGateway();
    try {
      await shared.start();
    } catch (error) {
      shared = undefined;
      throw error;
    }
  }
  return shared;
}

export async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待超时");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}
export async function started(gateway: StubGateway, token = "dev"): Promise<ChatSession> {
  const session = new ChatSession({ baseUrl: gateway.url, token }, undefined, { retryDelays: [100, 200] });
  sessions.add(session);
  await session.start();
  await until(() => session.connection === "open");
  return session;
}

export function texts(session: ChatSession, id: string, type: string): string[] {
  return session.timeline(id).events.filter((e) => e.type === type).map((e) => e.data.text);
}

export async function serverHistory(gateway: StubGateway, id: string): Promise<GatewayEvent[]> {
  return (await new GatewayApi({ baseUrl: gateway.url, token: "dev" }).history(id, undefined, 200)).events;
}
