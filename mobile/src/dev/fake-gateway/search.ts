import type { SearchResult } from '../../gateway/api.ts';
import type { Handler } from './types.ts';
import { jsonResponse } from './response.ts';

export const searchRoutes = {
  'GET /search': ({ gateway, url }) => {
    const query = url.searchParams.get('q') ?? '';
    const results: SearchResult[] = gateway.state.conversations.filter(row => row.last_text !== null && `${row.title} ${row.last_text}`.includes(query)).map(row => ({ kind: 'conversation', id: row.id, agent_id: row.agent_id, title: row.title }));
    for (const file of gateway.state.files.values()) {
      if (file.name.includes(query) && (!url.searchParams.has('agent_id') || file.agent_id === url.searchParams.get('agent_id'))) {
        results.push({ kind: 'file', id: file.id, title: file.name, file });
      }
    }
    return jsonResponse({ results, total: results.length, as_of_seq: gateway.state.seq });
  },
} satisfies Record<string, Handler>;
