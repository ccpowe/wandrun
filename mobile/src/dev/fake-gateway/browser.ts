import type { Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

export const browserRoutes = {
  'GET /browser-tasks': ({ gateway }) => jsonResponse({ browser_tasks: gateway.state.browserTasks, as_of_seq: gateway.state.seq }),
  'GET /browser-tasks/:id': ({ gateway, params }) => {
    const task = gateway.state.browserTasks.find(row => row.id === params.id);
    return task ? jsonResponse(task) : missing('浏览器任务已结束');
  },
  'DELETE /browser-tasks/:id': ({ gateway, params }) => {
    const task = gateway.state.browserTasks.find(row => row.id === params.id);
    if (!task) return missing('浏览器任务已结束');
    task.state = 'released'; task.pages = [];
    return jsonResponse({ browser_task: task });
  },
} satisfies Record<string, Handler>;

export const browserUnsupportedRoutes: Record<string, string> = {
  "POST /browser-tasks/:id/takeover": "当前 Storybook 只展示任务列表，不建立真实浏览器画面或接管会话。",
  "POST /browser-tasks/:id/handback": "当前 Storybook 只展示任务列表，不建立真实浏览器画面或接管会话。",
  "DELETE /browser-tasks/:id/pages/:page": "当前 Storybook 只展示任务列表，不建立真实浏览器画面或接管会话。",
  "GET /browser-tasks/:id/thumbnail": "当前 Storybook 只展示任务列表，不建立真实浏览器画面或接管会话。",
  "GET /browser-tasks/:id/stream": "当前 Storybook 只展示任务列表，不建立真实浏览器画面或接管会话。"
};
