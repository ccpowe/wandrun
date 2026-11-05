import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import MemoryReaderRoute from '../src/app/memory-reader';
import MemoryEditorRoute from '../src/app/memory-editor';
import MemoryDetailRoute from '../src/app/memory-detail';
import { FakeGateway, jsonResponse, unavailable, type GatewayOverrides } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
const memoryPath = '/agents/research/memory';
const routes = { '/memory-editor': MemoryEditorRoute, '/memory-detail': MemoryDetailRoute };
const draftText = '实际已经保存的草稿';
beforeEach(() => {
  jest.useFakeTimers();
  peer = new FakeGateway();
  seedGatewayAgent(peer);
  peer.state.memories.set(memoryPath, {
    scope: 'work', agent_id: 'research', content: '原记忆', version: 'v1',
    details: {}, limit: 1000, updated_at: null, updated_by: null,
  });
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

async function open(detail: boolean, existing = false) {
  if (existing) {
    const ref = { path: `/.wandrun/memory/work/details/project/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
    peer.state.memories.set(memoryPath, { ...peer.state.memories.get(memoryPath)!, details: { project: ref } });
    peer.state.memoryBodies.set(`${memoryPath}/details/project`, '原详情');
  }
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  if (detail) {
    await fireEvent.press(screen.getByTestId(existing ? 'memory-editor-detail-project' : 'memory-editor-new-detail')); await tick();
    if (existing) await fireEvent.press(screen.getByTestId('memory-detail-edit'));
    else await fireEvent.changeText(screen.getByTestId('memory-detail-slug'), 'project');
  }
  await fireEvent.changeText(screen.getByTestId(detail ? 'memory-detail-input' : 'memory-editor-input'), draftText);
}

for (const { detail, existing } of [{ detail: false, existing: false }, { detail: true, existing: false }, { detail: true, existing: true }]) {
  const name = detail ? existing ? '详情编辑' : '详情新建' : '索引保存';
  const prefix = detail ? 'memory-detail' : 'memory-editor';
  const endpoint: keyof GatewayOverrides = detail ? 'PUT /agents/:id/memory/details/:slug' : 'PUT /agents/:id/memory';
  const destination = detail ? 'memory-editor-input' : 'profile-memory-content';

  test(`${name}：写入已执行但回执丢失时，不得重复提交；只读核对已存后返回`, async () => {
    const gate = Promise.withResolvers<void>();
    let writes = 0, checks = 0;
    peer.overrides[endpoint] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
    peer.overrides['GET /agents/:id/memory'] = async () => {
      if (writes) { checks++; await gate.promise; }
    };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(detail ? peer.state.memoryBodies.get(`${memoryPath}/details/project`) : peer.state.memories.get(memoryPath)!.content).toBe(draftText);
    expect(screen.getByTestId('memory-save-unconfirmed')).toBeOnTheScreen();
    expect(screen.getByTestId(`${prefix}-save`)).toBeDisabled();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveProp('editable', false);
    if (detail && !existing) expect(screen.getByTestId('memory-detail-slug')).toHaveProp('editable', false);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick(1000);
    expect(writes).toBe(1);
    expect(checks).toBe(1);
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    expect(screen.queryByTestId('memory-save-unconfirmed')).toBeNull();
    expect(writes).toBe(1);
  });

  test(`${name}：核对仍为原版本则恢复编辑并保留草稿，只在用户再次保存时写入`, async () => {
    let writes = 0;
    peer.overrides[endpoint] = () => ++writes === 1 ? unavailable() : undefined;
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    expect(screen.getByTestId(`${prefix}-input`)).toHaveProp('editable', true);
    expect(screen.getByTestId(`${prefix}-save`)).toBeEnabled();
    expect(screen.queryByTestId('memory-save-unconfirmed')).toBeNull();
    expect(screen.getByTestId(`${prefix}-save-result`)).toBeOnTheScreen();
    expect(writes).toBe(1);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    expect(writes).toBe(2);
    expect(detail ? peer.state.memoryBodies.get(`${memoryPath}/details/project`) : peer.state.memories.get(memoryPath)!.content).toBe(draftText);
  });

  test(`${name}：核对为其他版本不采用为 CAS 基线，保留草稿并要求显式重载`, async () => {
    let writes = 0;
    const versions: string[] = [];
    peer.overrides[endpoint] = ({ body }) => {
      if (!body || typeof body !== 'object' || !('version' in body) || typeof body.version !== 'string') throw new Error('Missing memory CAS version');
      versions.push(body.version);
      if (++writes !== 1) return;
      peer.state.memories.set(memoryPath, { ...peer.state.memories.get(memoryPath)!, content: '别处的新记忆', version: 'v2' });
      return unavailable();
    };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(screen.getByTestId(`${prefix}-conflict`)).toBeOnTheScreen();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    expect(screen.getByTestId(`${prefix}-save`)).toBeDisabled();
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(versions).toEqual(['v1']);
    await fireEvent.press(screen.getByTestId(`${prefix}-reload`)); await tick();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(versions).toEqual(['v1', 'v2']);
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
  });

  test(`${name}：核对失败保持未知且不定时循环，断线期间不核对，重连后自动只读核对`, async () => {
    let writes = 0, checks = 0, recovered = false;
    peer.overrides[endpoint] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
    peer.overrides['GET /agents/:id/memory'] = () => {
      if (writes) { checks++; if (!recovered) return unavailable(); }
    };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick(5000);
    expect(checks).toBe(1);
    expect(screen.getByTestId('memory-save-unconfirmed')).toBeOnTheScreen();
    expect(screen.getByTestId('memory-save-unconfirmed')).toHaveTextContent('保存结果未确认。离开后再进入，会显示网关上实际保存的内容。');
    expect(screen.getByTestId(`${prefix}-save`)).toBeDisabled();
    expect(screen.queryByText('重新核对')).toBeNull();
    await act(() => {
      peer.overrides['GET /events'] = () => unavailable();
      peer.disconnect();
    }); await tick(5000);
    expect(checks).toBe(1);
    recovered = true;
    delete peer.overrides['GET /events'];
    await tick(15000);
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    expect(writes).toBe(1);
  });

  test(`${name}：未确认离开先提示草稿丢失；继续停留不提交，确认离开后迟到核对不再导航`, async () => {
    const gate = Promise.withResolvers<void>();
    let writes = 0;
    peer.overrides[endpoint] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
    peer.overrides['GET /agents/:id/memory'] = async () => { if (writes) await gate.promise; };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
    expect(screen.getByTestId('memory-save-leave-dialog')).toBeOnTheScreen();
    expect(screen.getByText('保存结果未确认，离开后本次草稿不会保留。')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('memory-save-stay')); await tick();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    expect(screen.getByTestId(`${prefix}-save`)).toBeDisabled();
    expect(writes).toBe(1);
    await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
    await fireEvent.press(screen.getByTestId('memory-save-leave')); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    expect(screen.queryByTestId('memory-save-unconfirmed')).toBeNull();
    expect(writes).toBe(1);
  });

  test(`${name}：重新聚焦接受未存的新回执，忽略迟到的旧成功回执`, async () => {
    const old = Promise.withResolvers<void>();
    let writes = 0, checks = 0, oldReleased = false;
    const ref = { path: `/.wandrun/memory/work/details/project/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
    peer.overrides[endpoint] = () => { writes++; return unavailable(); };
    peer.overrides['GET /agents/:id/memory'] = async () => {
      if (writes && ++checks === 1) {
        const stale = { ...peer.state.memories.get(memoryPath)!, content: draftText, version: 'old-saved', details: detail ? { project: ref } : {} };
        await old.promise;
        return jsonResponse(stale);
      }
    };
    peer.overrides['GET /agents/:id/memory/details/:slug'] = () => oldReleased
      ? jsonResponse({ scope: 'work', agent_id: 'research', slug: 'project', content: draftText, version: 'old-saved', ...ref, limit: 65536 }) : undefined;
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    await act(() => router.push('/memory-reader?scope=work&id=research')); await tick();
    await act(() => router.back()); await tick();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    expect(screen.getByTestId(`${prefix}-save`)).toBeEnabled();
    await act(() => { oldReleased = true; old.resolve(); }); await tick();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    expect(screen.getByTestId(`${prefix}-save`)).toBeEnabled();
    expect(writes).toBe(1);
  });

  test(`${name}：核对途中收到修订事件，不等旧读取返回即自动核对当前版本`, async () => {
    const old = Promise.withResolvers<void>();
    let writes = 0, checks = 0;
    peer.overrides[endpoint] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
    peer.overrides['GET /agents/:id/memory'] = async (_context, respond) => {
      if (writes && ++checks === 1) { const response = await respond(); await old.promise; return response; }
    };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    await act(() => {
      peer.state.memories.set(memoryPath, { ...peer.state.memories.get(memoryPath)!, version: 'newest-v3' });
      peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }));
    }); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    await act(() => old.resolve()); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    expect(writes).toBe(1);
  });

  test.each(['not-saved', 'conflict']) (`${name}：离开确认打开时核对为 %s，关闭未知确认并保留草稿`, async (outcome) => {
    const gate = Promise.withResolvers<void>();
    let attempted = false;
    peer.overrides[endpoint] = () => { attempted = true; return unavailable(); };
    peer.overrides['GET /agents/:id/memory'] = async () => { if (attempted) await gate.promise; };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    await fireEvent.press(screen.getByTestId(`${prefix}-back`)); await tick();
    expect(screen.getByTestId('memory-save-leave-dialog')).toBeOnTheScreen();
    if (outcome === 'conflict') peer.state.memories.set(memoryPath, { ...peer.state.memories.get(memoryPath)!, version: 'changed-v2' });
    await act(() => gate.resolve()); await tick();
    expect(screen.queryByTestId('memory-save-leave-dialog')).toBeNull();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    if (outcome === 'conflict') expect(screen.getByTestId(`${prefix}-conflict`)).toBeOnTheScreen();
    else expect(screen.getByTestId(`${prefix}-save`)).toBeEnabled();
  });

  test(`${name}：普通重读保留保存拒绝提示，直到用户修改草稿`, async () => {
    peer.overrides[endpoint] = () => unavailable('内容不合法', 400);
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    expect(screen.getByTestId(`${prefix}-error`)).toBeOnTheScreen();
    await act(() => peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }))); await tick();
    expect(screen.getByTestId(`${prefix}-error`)).toBeOnTheScreen();
    expect(screen.getByTestId(`${prefix}-input`)).toHaveDisplayValue(draftText);
    await fireEvent.changeText(screen.getByTestId(`${prefix}-input`), `${draftText}，已修改`);
    expect(screen.queryByTestId(`${prefix}-error`)).toBeNull();
  });

  test.each(detail ? ['index', 'detail'] : ['index'])(`${name}：连续修订取消上一轮 %s GET，在途读取不累积`, async (phase) => {
    const release = Promise.withResolvers<void>();
    let writes = 0, inFlight = 0, peak = 0;
    peer.overrides[endpoint] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
    const reading: keyof GatewayOverrides = phase === 'index' ? 'GET /agents/:id/memory' : 'GET /agents/:id/memory/details/:slug';
    peer.overrides[reading] = async ({ init }) => {
      if (!writes) return;
      const signal = init.signal;
      if (!signal) throw new Error('Recovery read has no cancellation signal');
      inFlight++;
      peak = Math.max(peak, inFlight);
      const aborted = Promise.withResolvers<void>();
      const cancel = () => { inFlight--; aborted.reject(new Error('aborted')); };
      signal.addEventListener('abort', cancel, { once: true });
      try { await Promise.race([release.promise, aborted.promise]); }
      finally { signal.removeEventListener('abort', cancel); if (!signal.aborted) inFlight--; }
    };
    await open(detail, existing);
    await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
    for (let event = 0; event < 5; event++) {
      await act(() => peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }))); await tick();
      expect(inFlight).toBe(1);
    }
    expect(peak).toBe(1);
    await act(() => release.resolve()); await tick();
    expect(screen.getByTestId(destination)).toBeOnTheScreen();
    expect(inFlight).toBe(0);
    expect(writes).toBe(1);
  });
}

test('详情索引/正文版本不一致时立即补读一组，取得同版结果后成功，无需连接或焦点变化', async () => {
  let written = false, mismatches = 0;
  peer.overrides['PUT /agents/:id/memory/details/:slug'] = async (_context, respond) => { await respond(); written = true; return unavailable(); };
  peer.overrides['GET /agents/:id/memory/details/:slug'] = async (_context, respond) => {
    const response = await respond();
    return written && ++mismatches === 1 ? jsonResponse({ ...await response.json(), version: 'another-version' }) : response;
  };
  await open(true);
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toBeOnTheScreen();
  expect(mismatches).toBe(2);
});

test('详情持续版本不一致只补读一组，后续修订事件再触发，不定时循环', async () => {
  let written = false, checks = 0, stable = false;
  peer.overrides['PUT /agents/:id/memory/details/:slug'] = async (_context, respond) => { await respond(); written = true; return unavailable(); };
  peer.overrides['GET /agents/:id/memory/details/:slug'] = async (_context, respond) => {
    const response = await respond();
    if (written) checks++;
    return written && !stable ? jsonResponse({ ...await response.json(), version: 'another-version' }) : response;
  };
  await open(true);
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick(5000);
  expect(checks).toBe(2);
  expect(screen.getByTestId('memory-save-unconfirmed')).toBeOnTheScreen();
  stable = true;
  await act(() => peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }))); await tick();
  expect(screen.getByTestId('memory-editor-input')).toBeOnTheScreen();
});

test('同标识详情重建并成功重读后清除删除提示，保留本地草稿和冲突保护', async () => {
  await open(true, true);
  const original = peer.state.memories.get(memoryPath)!;
  await act(() => {
    peer.state.memories.set(memoryPath, { ...original, version: 'deleted-v2', details: {} });
    peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.getByTestId('memory-detail-error')).toBeOnTheScreen();
  await act(() => {
    peer.state.memories.set(memoryPath, { ...original, version: 'recreated-v3' });
    peer.state.memoryBodies.set(`${memoryPath}/details/project`, '重新创建的正文');
    peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.queryByTestId('memory-detail-error')).toBeNull();
  expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue(draftText);
  expect(screen.getByTestId('memory-detail-save')).toBeDisabled();
});
