import { ChatSession } from '../src/gateway/session';
import { FakeGateway, jsonResponse, unavailable } from '../src/dev/fake-gateway';
import { SkillDeletion } from '../src/lib/skill-deletion';
import { attachSessionQueries } from '../src/lib/gateway-queries';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function setup() {
  const peer = new FakeGateway();
  peer.state.skills = [{ name: 'research', description: '核对来源', status: 'ok', error: null, used_by: [], path: '/skills/research/SKILL.md', mtime: 1, content: '# 核对' }];
  const session = new ChatSession({ computerId: 'cleanup', baseUrl: 'https://cleanup.invalid', token: 'test' }, peer.fetch);
  attachSessionQueries(session);
  return { peer, session, deletion: new SkillDeletion(session, 'research') };
}

test('删除核对失败后关闭电脑会话，不得遗留退避重试定时器', async () => {
  const { peer, session, deletion } = setup();
  let deleting = false;
  const remove = jest.fn(() => { deleting = true; return unavailable(); });
  peer.overrides['DELETE /skills/:name'] = remove;
  peer.overrides['GET /skills/:name'] = () => deleting ? unavailable() : undefined;
  try {
    await session.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(session.connection).toBe('open');
    await deletion.preflight();
    expect(deletion.snapshot().phase).toBe('confirm');
    await deletion.remove();
    await jest.advanceTimersByTimeAsync(0);
    expect(deletion.snapshot().phase).toBe('unknown');
    // Unknown writes cannot be repeated even when the user triggers deletion again.
    await deletion.remove();
    expect(remove).toHaveBeenCalledTimes(1);
    const stopped: number[] = [];
    const secondStopped: number[] = [];
    session.subscribe(() => { if (session.connection === 'stopped') stopped.push(session.getVersion()); });
    session.subscribe(() => { if (session.connection === 'stopped') secondStopped.push(session.getVersion()); });
    const version = session.getVersion();
    const closing = session.close();
    expect(session.close()).toBe(closing);
    await closing;
    await session.close();
    expect(stopped).toEqual([version + 1]);
    expect(secondStopped).toEqual(stopped);
    expect(session.api.signal.aborted).toBe(true);
    peer.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(session.connection).toBe('stopped');
    // Consume the old backoff window too: a surviving count then proves recurring
    // work after teardown, not merely one callback already queued at close().
    await jest.advanceTimersByTimeAsync(20_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(deletion.snapshot().phase).toBe('unknown');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(stopped).toEqual([version + 1]);
  } finally {
    await session.close();
    peer.disconnect();
  }
});

test.each(['success', 'failure'] as const)('关闭中止在途核对，迟到的 %s 不再更新状态或重排重试', async (result) => {
  const { peer, session, deletion } = setup();
  const gate = Promise.withResolvers<Response>();
  let checking = false;
  let signal: AbortSignal | null | undefined;
  const remove = jest.fn(() => { checking = true; return unavailable(); });
  peer.overrides['DELETE /skills/:name'] = remove;
  peer.overrides['GET /skills/:name'] = ({ init }) => {
    if (!checking) return;
    signal = init.signal;
    return gate.promise;
  };
  try {
    await session.start();
    await jest.advanceTimersByTimeAsync(0);
    await deletion.preflight();
    await deletion.remove();
    await jest.advanceTimersByTimeAsync(0);
    expect(deletion.snapshot().phase).toBe('unknown');
    expect(signal?.aborted).toBe(false);
    await session.close();
    expect(signal?.aborted).toBe(true);
    const terminal = deletion.snapshot();
    gate.resolve(result === 'success' ? jsonResponse(peer.state.skills[0]) : unavailable());
    await jest.advanceTimersByTimeAsync(20_000);
    expect(deletion.snapshot()).toBe(terminal);
    expect(jest.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve(unavailable());
    await session.close();
    peer.disconnect();
  }
});

test('取消确认不删除；重复提交及关闭后迟到的 DELETE 失败不重放或启动核对', async () => {
  const { peer, session, deletion } = setup();
  const gate = Promise.withResolvers<Response>();
  const remove = jest.fn(() => gate.promise);
  const read = jest.fn(() => undefined);
  peer.overrides['DELETE /skills/:name'] = remove;
  peer.overrides['GET /skills/:name'] = read;
  try {
    await session.start();
    await jest.advanceTimersByTimeAsync(0);
    await deletion.preflight();
    deletion.cancel();
    await deletion.remove();
    expect(deletion.snapshot().phase).toBe('idle');
    expect(remove).not.toHaveBeenCalled();
    await deletion.preflight();
    const removing = deletion.remove();
    await deletion.remove();
    expect(remove).toHaveBeenCalledTimes(1);
    const closing = session.close();
    gate.resolve(unavailable());
    await Promise.all([closing, removing]);
    await jest.advanceTimersByTimeAsync(20_000);
    await deletion.preflight();
    await deletion.remove();
    expect(read).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    gate.resolve(unavailable());
    await session.close();
    peer.disconnect();
  }
});
