import type { Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

export const skillsRoutes = {
  'GET /skills': ({ gateway }) => jsonResponse({ skills: gateway.state.skills, as_of_seq: gateway.state.seq, default_agent_id: gateway.state.agents[0]?.id ?? null }),
  'GET /skills/:name': ({ gateway, params }) => {
    const skill = gateway.state.skills.find(row => row.name === params.name);
    return skill ? jsonResponse(skill) : missing('技能不存在');
  },
  'DELETE /skills/:name': ({ gateway, params }) => {
    const skill = gateway.state.skills.find(row => row.name === params.name);
    if (!skill) return jsonResponse({ event: null });
    if (skill.used_by.length) return jsonResponse({ error: { code: 'rejected', message: '技能仍被使用', details: { used_by: skill.used_by } } }, 409);
    gateway.state.skills = gateway.state.skills.filter(row => row.name !== params.name);
    const event = gateway.event('resource.changed', { kind: 'skill', id: params.name, op: 'deleted' });
    gateway.emit(event);
    return jsonResponse({ event });
  },
  'GET /builtin-skills': ({ gateway }) => jsonResponse({ skills: gateway.state.builtinSkills }),
  'GET /builtin-skills/:name': ({ gateway, params }) => {
    const skill = gateway.state.builtinSkills.find(row => row.name === params.name);
    return skill ? jsonResponse(skill) : missing('内置技能不存在');
  },
} satisfies Record<string, Handler>;
