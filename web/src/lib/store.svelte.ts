import { api, type Bookmark, type Topic } from "./api";

export const store = $state({
  bookmarks: [] as Bookmark[],
  topics: [] as Topic[],
  nextCursor: null as string | null,
  loading: false,
  exhausted: false,
  error: "",
  toast: "",
  // filters
  q: "",
  type: "",
  topic: "",
  domain: "",
  read: "" as "" | "0" | "1",
  sort: "" as "" | "oldest",
  // ui
  view: "grid" as "grid" | "list",
  detailId: null as string | null,
  page: "library" as "library" | "settings",
  selected: [] as string[],
  stalePoll: false, // poll gave up with cards still pending — offer refresh
});

let toastTimer: ReturnType<typeof setTimeout>;
export function showToast(message: string) {
  store.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = ""), 4000);
}

// Central error path for user actions: surface the failure instead of leaving
// a frozen button, and route auth failures to Settings.
export async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.message === "unauthorized") {
      store.page = "settings";
      showToast("Unauthorized — check your token in Settings");
    } else {
      showToast(e?.message ?? "Something went wrong");
    }
    return undefined;
  }
}

function filterParams(): Record<string, string> {
  const p: Record<string, string> = { limit: "50" };
  if (store.q) p.q = store.q;
  if (store.type) p.type = store.type;
  if (store.topic) p.topic = store.topic;
  if (store.domain) p.domain = store.domain;
  if (store.read) p.read = store.read;
  if (store.sort) p.sort = store.sort;
  return p;
}

function cursorOf(res: { next_before: string | null; next_after?: string | null }): string | null {
  return store.sort === "oldest" ? res.next_after ?? null : res.next_before;
}

export async function reload() {
  store.loading = true;
  store.error = "";
  store.selected = [];
  try {
    const res = await api.list(filterParams());
    store.bookmarks = res.bookmarks;
    store.nextCursor = cursorOf(res);
    store.exhausted = store.nextCursor === null;
    pollPending();
  } catch (e: any) {
    store.error = e.message;
    if (e?.message === "unauthorized") store.page = "settings";
  } finally {
    store.loading = false;
  }
}

export async function loadMore() {
  if (store.loading || store.exhausted || store.nextCursor === null) return;
  store.loading = true;
  try {
    const cursorParam = store.sort === "oldest" ? "after" : "before";
    const res = await api.list({ ...filterParams(), [cursorParam]: store.nextCursor });
    store.bookmarks.push(...res.bookmarks);
    store.nextCursor = cursorOf(res);
    store.exhausted = store.nextCursor === null;
    pollPending();
  } catch (e: any) {
    store.error = e.message;
  } finally {
    store.loading = false;
  }
}

export async function reloadTopics() {
  try {
    store.topics = (await api.topics()).topics;
  } catch {
    /* topics are non-critical for the library view */
  }
}

// Poll enrichment status for pending cards: one batched request per round
// (~2s cadence for a minute, then 10s), give up after ~5 minutes and flag it.
let polling = false;
async function pollPending() {
  if (polling) return;
  polling = true;
  store.stalePoll = false;
  try {
    const started = Date.now();
    while (Date.now() - started < 5 * 60_000) {
      const pending = store.bookmarks.filter((b) => b.enrich_status === "pending");
      if (!pending.length) return;
      const fast = Date.now() - started < 60_000;
      await new Promise((r) => setTimeout(r, fast ? 2000 : 10_000));
      try {
        const ids = pending.slice(0, 100).map((b) => b.id);
        const { statuses } = await api.statusBatch(ids);
        const byId = new Map(statuses.map((s) => [s.id, s]));
        const missing = ids.filter((id) => !byId.has(id));
        for (const id of missing) {
          // Deleted server-side (post-redirect dedup) — drop the ghost card.
          store.bookmarks = store.bookmarks.filter((b) => b.id !== id);
        }
        const changed = statuses.filter((s) => s.enrich_status !== "pending");
        for (const s of changed) {
          const fresh = await api.get(s.id).catch(() => null);
          const idx = store.bookmarks.findIndex((x) => x.id === s.id);
          if (fresh && idx >= 0) store.bookmarks[idx] = fresh;
        }
      } catch {
        /* transient network failure — next round retries */
      }
    }
    if (store.bookmarks.some((b) => b.enrich_status === "pending")) store.stalePoll = true;
  } finally {
    polling = false;
  }
}

export function updateBookmark(updated: Bookmark) {
  const idx = store.bookmarks.findIndex((b) => b.id === updated.id);
  if (idx >= 0) store.bookmarks[idx] = updated;
}

export function removeBookmark(id: string) {
  store.bookmarks = store.bookmarks.filter((b) => b.id !== id);
  if (store.detailId === id) store.detailId = null;
  store.selected = store.selected.filter((s) => s !== id);
}

// ---- selection / bulk operations ----

export function toggleSelected(id: string) {
  store.selected = store.selected.includes(id)
    ? store.selected.filter((s) => s !== id)
    : [...store.selected, id];
}

async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export async function bulkMarkRead(read: boolean) {
  const ids = [...store.selected];
  await guarded(() =>
    inChunks(ids, 5, async (id) => {
      const updated = await api.patch(id, { is_read: read });
      updateBookmark(updated);
    })
  );
  store.selected = [];
}

export async function bulkDelete() {
  const ids = [...store.selected];
  if (!confirm(`Delete ${ids.length} bookmark(s)? They stay in trash for 30 days.`)) return;
  await guarded(() =>
    inChunks(ids, 5, async (id) => {
      await api.remove(id);
      removeBookmark(id);
    })
  );
  store.selected = [];
}

// ---- URL <-> state sync (refresh keeps filters, back closes the panel) ----

const HASH_KEYS = ["q", "type", "topic", "domain", "read", "sort", "view", "detail", "page"] as const;

export function buildHash(): string {
  const p = new URLSearchParams();
  if (store.q) p.set("q", store.q);
  if (store.type) p.set("type", store.type);
  if (store.topic) p.set("topic", store.topic);
  if (store.domain) p.set("domain", store.domain);
  if (store.read) p.set("read", store.read);
  if (store.sort) p.set("sort", store.sort);
  if (store.view !== "grid") p.set("view", store.view);
  if (store.detailId) p.set("detail", store.detailId);
  if (store.page !== "library") p.set("page", store.page);
  const s = p.toString();
  return s ? `#${s}` : "";
}

// Applies a location.hash to the store. Returns true when a filter changed
// (meaning the caller should reload the list).
export function applyHash(hash: string): boolean {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const get = (k: (typeof HASH_KEYS)[number]) => p.get(k) ?? "";
  const filtersBefore = JSON.stringify([store.q, store.type, store.topic, store.domain, store.read, store.sort]);
  store.q = get("q");
  store.type = get("type");
  store.topic = get("topic");
  store.domain = get("domain");
  store.read = get("read") as typeof store.read;
  store.sort = get("sort") as typeof store.sort;
  store.view = get("view") === "list" ? "list" : "grid";
  store.detailId = p.get("detail");
  store.page = get("page") === "settings" ? "settings" : "library";
  const filtersAfter = JSON.stringify([store.q, store.type, store.topic, store.domain, store.read, store.sort]);
  return filtersBefore !== filtersAfter;
}
