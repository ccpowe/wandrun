import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatSession } from "../src/gateway/session.ts";
import { SessionOwner } from "../src/lib/session-owner.ts";
import type { SavedComputer } from "../src/lib/credentials.ts";

const a: SavedComputer = { computerId: "a", connectionId: "pair-a", baseUrl: "http://same", token: "a" };
const b: SavedComputer = { computerId: "b", connectionId: "pair-b", baseUrl: "http://same", token: "b" };

test("switch closes the old session immediately but does not open another until uploads and transports settle", async () => {
  const uploadStopped = Promise.withResolvers<void>();
  const transportStopped = Promise.withResolvers<void>();
  const order: string[] = [];
  class Session extends ChatSession {
    override async start() { order.push(`start:${this.api.config.token}`); }
    override async close() {
      order.push(`close:${this.api.config.token}`);
      await super.close();
      if (this.api.config.token === "a") await transportStopped.promise;
    }
  }
  const owner = new SessionOwner((config) => new Session(config), async (computerId) => {
    order.push(`pause:${computerId}`);
    if (computerId === "a") await uploadStopped.promise;
  });
  await owner.select(a);
  const original = owner.snapshot()!;
  const switching = owner.select(b);
  assert.equal(original.session.api.signal.aborted, true);
  assert.equal(owner.snapshot(), null);
  assert.deepEqual(order, ["start:a", "pause:a", "close:a"]);
  transportStopped.resolve();
  await Promise.resolve();
  assert.equal(owner.snapshot(), null);
  uploadStopped.resolve();
  await switching;
  assert.equal(owner.snapshot()?.owner.computerId, "b");
  assert.deepEqual(order, ["start:a", "pause:a", "close:a", "start:b"]);
  await owner.select(a);
  assert.notEqual(owner.snapshot()?.session, original.session);
  assert.notEqual(owner.snapshot()?.key, original.key);
  await owner.select(null);
});

test("rapid selections skip superseded computers; notes keep the active connection and navigation", async () => {
  const paused = Promise.withResolvers<void>();
  const starts: string[] = [];
  class Session extends ChatSession {
    override async start() { starts.push(this.api.config.token); }
  }
  const owner = new SessionOwner((config) => new Session(config), async () => paused.promise);
  await owner.select(a);
  const first = owner.snapshot();
  await owner.select({ ...a, localName: "Local note" });
  assert.equal(owner.snapshot(), first);
  const toB = owner.select(b);
  const back = owner.select(a);
  paused.resolve();
  await Promise.all([toB, back]);
  assert.deepEqual(starts, ["a", "a"]);
  assert.equal(owner.snapshot()?.owner.computerId, "a");
  await owner.select(null);
  assert.equal(owner.snapshot(), null);
});
