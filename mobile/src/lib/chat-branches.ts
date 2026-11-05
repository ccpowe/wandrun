import type { ChatSession, TaskView } from '../gateway/session.ts';

/** Attention means human intervention, not unread messages. */
export function taskNeedsAttention(session: ChatSession, task: TaskView): boolean {
  return task.status === 'failed' || task.status === 'unavailable' ||
    [...session.browserTasks.values()].some((lease) => lease.task_id === task.id && lease.state === 'requested');
}

/** Follow creator links so each ancestor sees a descendant's intervention request. */
export function subtreeNeedsAttention(session: ChatSession, id: string): boolean {
  for (const task of session.tasks.values()) {
    if (!taskNeedsAttention(session, task)) continue;
    let parent: string | undefined = task.creator_task_id;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === id) return true;
      visited.add(parent);
      parent = session.tasks.get(parent)?.creator_task_id;
    }
  }
  return false;
}

export function branchNeedsAttention(session: ChatSession, task: TaskView): boolean {
  return taskNeedsAttention(session, task) || subtreeNeedsAttention(session, task.id);
}

export function conversationChildren(session: ChatSession, id: string): TaskView[] {
  const rank = (task: TaskView) => branchNeedsAttention(session, task) ? 0 : task.branch_working ? 1 : 2;
  return [...session.tasks.values()].filter((task) => task.creator_task_id === id)
    .sort((a, b) => rank(a) - rank(b) || b.updated_at - a.updated_at);
}

export function rootBranches(session: ChatSession, id: string) {
  const tasks = [...session.tasks.values()].filter((task) => task.root_id === id);
  return { count: tasks.length, attention: subtreeNeedsAttention(session, id) };
}
