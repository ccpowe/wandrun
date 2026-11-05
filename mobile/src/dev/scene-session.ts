import type { Fetch, GatewayConfig } from '../gateway/api.ts';
import { ChatSession } from '../gateway/session.ts';
import { attachSessionQueries } from '../lib/gateway-queries.ts';
import { Credentials, type SavedComputer } from '../lib/credentials';
import { installFakeGatewayHost } from './fake-gateway-host';

/** A scene session owns its query bridge and native fake transports through start/close. */
export function createSceneSession(config: GatewayConfig, fetch: Fetch): ChatSession {
  const session = new ChatSession(config, fetch);
  attachSessionQueries(session);
  const start = session.start.bind(session);
  const close = session.close.bind(session);
  let releaseHost: (() => void) | undefined;
  session.start = async () => {
    if (!session.api.signal.aborted) releaseHost ??= installFakeGatewayHost({ baseUrls: [config.baseUrl], fetch });
    await start();
  };
  session.close = () => {
    // close() synchronously invalidates the API; release transports before its async
    // SSE barrier so the next mounted scene can start without inheriting this peer.
    const closing = close();
    releaseHost?.(); releaseHost = undefined;
    return closing;
  };
  return session;
}

/** Stories use the Provider's session; standalone component fixtures may own one explicitly. */
export function createSceneRuntime(config: SavedComputer, fetch: Fetch) {
  let stored: string | null = JSON.stringify({ computers: [config], currentId: config.computerId });
  const credentials = new Credentials({
    getItemAsync: async () => stored,
    setItemAsync: async (_key, value) => { stored = value; },
    deleteItemAsync: async () => { stored = null; },
  });
  let session: ChatSession | undefined;
  let ownsSession = false;
  let releaseHost: (() => void) | undefined;
  return {
    runtime: { credentials, fetch },
    get current() { return session; },
    get session() {
      if (!session) { session = createSceneSession(config, fetch); ownsSession = true; }
      return session;
    },
    async start(providedSession?: ChatSession) {
      if (providedSession && session !== providedSession) {
        if (ownsSession) await session?.close();
        session = providedSession;
        ownsSession = false;
      }
      const active = this.session;
      if (!ownsSession) releaseHost ??= installFakeGatewayHost({ baseUrls: [config.baseUrl], fetch });
      if (active.connection !== 'open') await active.start();
    },
    stop() {
      releaseHost?.(); releaseHost = undefined;
      if (ownsSession) void session?.close();
    },
  };
}
