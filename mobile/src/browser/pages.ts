import type { Pages } from "./protocol.ts";
import { t } from "../lib/i18n.ts";
import {
  addNotice, applyPages as applyLabPages, currentPage as selectedPage, EMPTY_PAGES, hostOf, type PageInfo, type PagesState,
} from "../takeover-lab/pages.ts";

export { activeNotice, collapseNotices, dismissNotice, hostOf } from "../takeover-lab/pages.ts";
export function pageLabel(page: PageInfo | null | undefined): string {
  if (!page) return "";
  return page.title.trim() || hostOf(page.url) || t("空白页");
}
export type PageState = PagesState & { snapshot: Pages | null };
export const EMPTY_PAGE_STATE: PageState = { ...EMPTY_PAGES, snapshot: null };

/** Selection belongs to one computer's screen, not to a socket: only confirmed snapshots survive reconnects. */
export type PageSelection = {
  computerId: string | null;
  route: string | null;
  confirmed: string | null;
  restoring: boolean;
  pending: string | null;
};

export function initialPageSelection(route?: string, computerId?: string): PageSelection {
  return { computerId: computerId ?? null, route: route ?? null, confirmed: null, restoring: true, pending: null };
}

export function resumePageSelection(selection: PageSelection, computerId = selection.computerId): PageSelection {
  if (selection.computerId !== computerId) return initialPageSelection(undefined, computerId ?? undefined);
  return { ...selection, restoring: true, pending: null };
}

/** Restore a known page once per connection; otherwise track the socket's confirmed current page. */
export function observePageSelection(selection: PageSelection, snapshot: Pages): { selection: PageSelection; switchTo: string | null } {
  if (selection.restoring) {
    const preferred = selection.confirmed ?? selection.route;
    const switchTo = preferred && preferred !== snapshot.current && snapshot.pages.some(({ id }) => id === preferred) ? preferred : null;
    return {
      selection: { ...selection, route: null, confirmed: switchTo ? selection.confirmed : snapshot.current, restoring: false, pending: switchTo },
      switchTo,
    };
  }
  if (selection.pending && selection.pending !== snapshot.current && snapshot.pages.some(({ id }) => id === selection.pending)) {
    return { selection, switchTo: null };
  }
  return { selection: { ...selection, confirmed: snapshot.current, pending: null }, switchTo: null };
}

export function rejectPageRestoration(selection: PageSelection, current: string | null): PageSelection {
  return { ...selection, confirmed: current, pending: null };
}

/** Only an authoritative human-control snapshot with no pages is the recoverable empty stage. */
export function isEmptyControlPages(state: PageState): boolean {
  return state.snapshot?.state === "human" && state.snapshot.pages.length === 0;
}

/** Formal snapshots carry control metadata; the established page reducer owns selection/notices. */
export function applyPages(state: PageState, snapshot: Pages, at: number): PageState {
  const seen = new Set(state.pages.map(({ id }) => id));
  let next = applyLabPages(state, snapshot);
  if (state.snapshot) for (const page of snapshot.pages) {
    if (!seen.has(page.id) && page.id !== snapshot.current) next = addNotice(next, page, at);
  }
  return { ...next, snapshot };
}

export function currentPage(state: PageState) { return selectedPage(state); }
