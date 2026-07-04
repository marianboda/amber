import { api, type Bookmark, type Topic } from "./api";

export const store = $state({
  bookmarks: [] as Bookmark[],
  topics: [] as Topic[],
  nextBefore: null as number | null,
  loading: false,
  exhausted: false,
  error: "",
  // filters
  q: "",
  type: "",
  topic: "",
  read: "" as "" | "0" | "1",
  // ui
  view: "grid" as "grid" | "list",
  detailId: null as string | null,
  page: "library" as "library" | "settings",
});

function filterParams(): Record<string, string> {
  const p: Record<string, string> = { limit: "50" };
  if (store.q) p.q = store.q;
  if (store.type) p.type = store.type;
  if (store.topic) p.topic = store.topic;
  if (store.read) p.read = store.read;
  return p;
}

export async function reload() {
  store.loading = true;
  store.error = "";
  try {
    const res = await api.list(filterParams());
    store.bookmarks = res.bookmarks;
    store.nextBefore = res.next_before;
    store.exhausted = res.next_before === null;
    pollPending();
  } catch (e: any) {
    store.error = e.message;
  } finally {
    store.loading = false;
  }
}

export async function loadMore() {
  if (store.loading || store.exhausted || store.nextBefore === null) return;
  store.loading = true;
  try {
    const res = await api.list({ ...filterParams(), before: String(store.nextBefore) });
    store.bookmarks.push(...res.bookmarks);
    store.nextBefore = res.next_before;
    store.exhausted = res.next_before === null;
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

// Poll enrichment status for visible pending cards (~2s cadence, stop after ~60s).
let polling = false;
async function pollPending() {
  if (polling) return;
  polling = true;
  try {
    for (let round = 0; round < 30; round++) {
      const pending = store.bookmarks.filter((b) => b.enrich_status === "pending");
      if (!pending.length) break;
      await new Promise((r) => setTimeout(r, 2000));
      for (const b of pending.slice(0, 20)) {
        try {
          const s = await api.status(b.id);
          if (s.enrich_status !== "pending") {
            const fresh = await api.get(b.id);
            const idx = store.bookmarks.findIndex((x) => x.id === b.id);
            if (idx >= 0) store.bookmarks[idx] = fresh;
          }
        } catch {
          /* bookmark may have been deleted (post-redirect dedup) */
        }
      }
    }
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
}
