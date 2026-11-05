import type { AgentSummary, SkillDetail } from '../gateway/api';
import { createSceneSession } from './scene-session';
import { FakeGateway, jsonResponse } from './fake-gateway';

export type SkillsSceneState = 'A1' | 'A2' | 'A2Collision' | 'A3' | 'A4' | 'A5' | 'A6' | 'C1' | 'C2' | 'C3' | 'C4Single' | 'C4Many' | 'C4Long' | 'C5' | 'D2' | 'D3' | 'D4-conflict' | 'D4-failed' | 'D4-unknown' | 'E1' | 'E2' | 'E3';
export const sampleSkill: SkillDetail = {
  name: 'source-check', description: '查找原始资料，核对来源与引用。', status: 'ok', error: null,
  used_by: [], path: '/workspace/skills/source-check/SKILL.md', mtime: 1793270400,
  content: '---\nname: source-check\ndescription: 核对来源\n---\n# 核对来源\n\n阅读原始资料，保留原文链接。',
};
/** All page data and faults cross the shared HTTP gateway; no page flags are injected. */
export function skillsScenario(state: SkillsSceneState) {
  let sent = false;
  const agents: AgentSummary[] = [
    { id: 'research', name: '研究员', avatar: 1, description: '查找并核对资料', workers: [], environment: 'local', latest_conversation: null, unread: false },
    { id: 'writer', name: '写作助手', avatar: 3, description: '整理笔记与写作', workers: [], environment: 'local', latest_conversation: null, unread: false },
  ];
  if (state === 'C4Many' || state === 'C4Long') agents.push(
    { ...agents[0], id: 'planner', name: '规划助手', avatar: 2 },
    { ...agents[0], id: 'reviewer', name: '审阅助手', avatar: 4 },
    { ...agents[0], id: 'archive', name: '资料助手', avatar: 5 },
  );
  if (state === 'C4Long') for (let index = 6; index <= 30; index++) agents.push({
    ...agents[0], id: `helper-${index}`, name: `资料助手 ${index}`, avatar: index % 8,
  });
  const gateway = new FakeGateway({
    agents,
    skills: state === 'A3' ? [] : [state === 'A2Collision' ? { ...sampleSkill, name: 'wandrun-ui', status: 'error', error: '名称被网关内置技能占用' } : state === 'C3' || state === 'A5' ? { ...sampleSkill, status: 'error', error: '缺少 SKILL.md', content: null, mtime: null } : sampleSkill,
      { ...sampleSkill, name: 'notes', description: '把阅读材料整理成清晰的笔记。',
      path: '/workspace/skills/notes/SKILL.md', content: '# 整理笔记\n\n把阅读材料整理成清晰的笔记。',
      used_by: (state === 'C4Single' ? agents.slice(0, 1) : agents).map(({ id, name }) => ({ id, name })) }],
    builtinSkills: [{ name: 'wandrun-ui', description: '在消息里展示交互界面。', capability: { id: 'ui_blocks', name: '交互界面' }, used_by: state === 'E2' ? agents.slice(0, 1).map(({ id, name }) => ({ id, name })) : [], content: '---\nname: wandrun-ui\n---\n# 交互界面\n\n随 Wandrun 更新的内置技能。' }],
  }, {
    'GET /events': () => { if (state === 'A6') return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503); },
    'GET /skills': () => {
      if (state === 'A1') return Promise.withResolvers<Response>().promise;
      if (state === 'A4') return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
    },
    'GET /builtin-skills': () => { if (state === 'A4') return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503); },
    'GET /skills/:name': () => {
      if (state === 'C5') return jsonResponse({ error: { code: 'not_found', message: '技能不存在' } }, 404);
      if (state === 'C1' || (sent && state === 'D4-unknown')) return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
    },
    'GET /builtin-skills/:name': () => {
      if (state === 'E1') return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
      if (state === 'E3') return jsonResponse({ error: { code: 'not_found', message: '技能不存在' } }, 404);
    },
    'DELETE /skills/:name': () => {
      sent = true;
      if (state === 'D4-conflict') return jsonResponse({ error: { code: 'conflict', message: '技能仍被使用', details: { used_by: agents.map(({ id, name }) => ({ id, name })) } } }, 409);
      if (state === 'D4-failed') return jsonResponse({ error: { code: 'forbidden', message: '技能目录只读，无法删除' } }, 403);
      if (state === 'D4-unknown') return jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
    },
  });
  const session = createSceneSession({ baseUrl: 'https://gallery.invalid', token: 'gallery' }, gateway.fetch);
  return { gateway, session, start() { void session.start(); }, stop() { gateway.disconnect(); void session.close(); } };
}
