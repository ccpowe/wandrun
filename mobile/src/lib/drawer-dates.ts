export type DrawerDateGroup = 'today' | 'yesterday' | 'older';
/** `unranked`: confirmed content but no user send / schedule trigger (conversation-drawer.P9); not an unconfirmed row. */
type Activity = { activityAt: number | null; unranked?: boolean };
export type DrawerConversationGroup<T> = { date: DrawerDateGroup; conversations: T[] };

/** Input order is the session's ranking order (user sends and schedule triggers). Grouping never invents timestamps. */
export function groupDrawerConversations<T extends Activity>(rows: readonly T[], now: Date): DrawerConversationGroup<T>[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const pending: T[] = [];
  const groups: Record<DrawerDateGroup, T[]> = { today: [], yesterday: [], older: [] };
  for (const row of rows) {
    if (row.activityAt === null) { (row.unranked ? groups.older : pending).push(row); continue; }
    const at = row.activityAt * 1000;
    groups[at >= today ? 'today' : at >= yesterday ? 'yesterday' : 'older'].push(row);
  }
  if (pending.length) groups.today = [...pending, ...groups.today];
  return (['today', 'yesterday', 'older'] as const)
    .filter(date => groups[date].length > 0).map(date => ({ date, conversations: groups[date] }));
}
