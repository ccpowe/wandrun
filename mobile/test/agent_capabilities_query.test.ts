import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryObserver } from '@tanstack/react-query';
import { ChatSession } from '../src/gateway/session.ts';
import { agentCapabilityOptions, attachSessionQueries, createGatewayQueryClient } from '../src/lib/gateway-queries.ts';

const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
test('capabilities.G1/G4 editor and page share pending read; definition revision cancels body and publishes committed replacement', async () => {
  const body = Promise.withResolvers<unknown>();
  const signals: AbortSignal[] = [];
  const listeners = new Set<() => void>();
  const client = createGatewayQueryClient(); client.mount();
  const session = new ChatSession({ baseUrl: 'http://capability.test', token: 'test' }, async (_input, init) => {
    signals.push(init!.signal!);
    return signals.length === 1 ? { ok: true, status: 200, json: () => body.promise } as Response
      : Response.json({ capabilities: [{ id: 'files', status: 'disabled' }] });
  });
  session.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  attachSessionQueries(session, client);
  const editor = new QueryObserver(client, agentCapabilityOptions(session, 'planner'));
  const page = new QueryObserver(client, agentCapabilityOptions(session, 'planner'));
  const stopEditor = editor.subscribe(() => {}); const stopPage = page.subscribe(() => {});
  try {
    await flush(); assert.equal(signals.length, 1);
    session.agents.definitionVersion++;
    for (const listener of listeners) listener();
    assert.equal(signals[0].aborted, true);
    await flush();
    assert.equal(page.getCurrentResult().data?.capabilities[0].status, 'disabled');
    body.resolve({ capabilities: [{ id: 'files', status: 'enabled' }] }); await flush();
    assert.equal(editor.getCurrentResult().data?.capabilities[0].status, 'disabled');
    stopEditor(); stopPage(); await session.close();
    assert.equal(client.getQueryData(agentCapabilityOptions(session, 'planner').queryKey), undefined);
  } finally { stopEditor(); stopPage(); await session.close(); client.unmount(); client.clear(); }
});
