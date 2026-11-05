import { z } from 'zod';
import type { Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

export const schedulesRoutes = {
  'GET /agents/:id/schedules': ({ gateway, params }) => jsonResponse({ schedules: gateway.state.schedules.filter(row => row.agent_id === params.id), default_timezone: 'Asia/Shanghai', as_of_seq: gateway.state.seq }),
  'GET /schedules/:id': ({ gateway, params }) => {
    const schedule = gateway.state.schedules.find(row => row.id === params.id);
    return schedule ? jsonResponse(schedule) : missing('定时不存在');
  },
  'PATCH /schedules/:id': ({ gateway, params, body: raw }) => {
    const changes = z.object({
      enabled: z.boolean(), name: z.string(), content: z.string(), timezone: z.string(),
      rule: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('once'), local_at: z.string() }),
        z.object({ kind: z.literal('daily'), time: z.string() }),
        z.object({ kind: z.literal('weekly'), time: z.string(), weekdays: z.array(z.number()) }),
        z.object({ kind: z.literal('cron'), expression: z.string() }),
      ]),
    }).partial().parse(raw);
    const schedule = gateway.state.schedules.find(row => row.id === params.id);
    if (!schedule) return missing('定时不存在');
    const updated = { ...schedule, ...changes, updated_at: Date.now() / 1000, next_run_at: changes.enabled === false ? null : changes.enabled === true ? gateway.state.scheduleNextRuns[schedule.id] : schedule.next_run_at };
    gateway.state.schedules = gateway.state.schedules.map(row => row.id === params.id ? updated : row);
    return jsonResponse({ schedule: updated, event: null });
  },
  'DELETE /schedules/:id': ({ gateway, params }) => {
    const schedule = gateway.state.schedules.find(row => row.id === params.id);
    if (!schedule) return missing('定时不存在');
    gateway.state.schedules = gateway.state.schedules.filter(row => row.id !== params.id);
    return jsonResponse({ event: gateway.event('resource.changed', { kind: 'schedule', id: params.id, agent_id: schedule.agent_id, op: 'deleted' }) });
  },
  'GET /schedules/:id/runs': ({ gateway, params, url }) => {
    const before = url.searchParams.get('before');
    const runs = (gateway.state.scheduleRuns.get(params.id) ?? []).filter(run => before === null || run.id < Number(before)).slice(0, 20);
    return jsonResponse({ runs, as_of_seq: gateway.state.seq });
  },
} satisfies Record<string, Handler>;

export const schedulesUnsupportedRoutes: Record<string, string> = {
  "POST /agents/:id/schedules": "当前 Storybook 未覆盖此表单或详情；不得以空成功响应代替实现。"
};
