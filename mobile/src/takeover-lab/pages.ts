// 浏览器任务页面集合的纯状态：快照权威，通知只影响本地提示，不切换连接选择。
// 正式通道只发送完整 pages 快照；新页通知从前后快照差异推导。

export type PageInfo = { id: string; title: string; url: string };
export type PagesMessage = { t: "pages"; current: string | null; vp: number; pages: PageInfo[] };

/** 提示自动收起的时间；收起只影响提示，页面仍在列表里。 */
export const NOTICE_MS = 6000;

export type Notice = { key: string; at: number; page: PageInfo };
export type PagesState = { pages: PageInfo[]; current: string | null; notices: Notice[] };

export const EMPTY_PAGES: PagesState = { pages: [], current: null, notices: [] };

/** 用快照替换列表与当前页；已不在列表的页面或已被切到的页面，它的提示作废。 */
export function applyPages(state: PagesState, message: PagesMessage): PagesState {
  const now = new Set(message.pages.map((page) => page.id));
  const notices = state.notices.filter((notice) => notice.page.id !== message.current && now.has(notice.page.id));
  return { pages: message.pages, current: message.current, notices };
}

/** 新页由快照差异发现后入队；同一页面不重复，当前页不提示。 */
export function addNotice(state: PagesState, page: PageInfo, at: number): PagesState {
  if (page.id === state.current || state.notices.some((notice) => notice.page.id === page.id)) return state;
  return { ...state, notices: [...state.notices, { key: page.id, at, page }] };
}

export function dismissNotice(state: PagesState, key: string): PagesState {
  return { ...state, notices: state.notices.filter((notice) => notice.key !== key) };
}

/** 收起超时的提示。 */
export function collapseNotices(state: PagesState, now: number): PagesState {
  const notices = state.notices.filter((notice) => now - notice.at < NOTICE_MS);
  return notices.length === state.notices.length ? state : { ...state, notices };
}

/** 当前该显示的提示：最新的一条；more 是此前未处理的条数。 */
export function activeNotice(state: PagesState): { notice: Notice; page: PageInfo; more: number } | null {
  const notice = state.notices[state.notices.length - 1];
  if (!notice) return null;
  return { notice, page: state.pages.find((page) => page.id === notice.page.id) ?? notice.page, more: state.notices.length - 1 };
}

export function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
}

/** 列表与顶部显示用的名字：有标题用标题，否则域名，再否则“空白页”。 */
export function pageLabel(page: PageInfo | null | undefined): string {
  if (!page) return "";
  return page.title.trim() || hostOf(page.url) || "空白页";
}

export function currentPage(state: PagesState): PageInfo | null {
  return state.pages.find((page) => page.id === state.current) ?? null;
}

