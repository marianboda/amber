// Shared client logic for talking to the Amber server from the extension.

export interface AmberSettings {
  serverUrl: string;
  token: string;
  device: string;
}

export async function getSettings(): Promise<AmberSettings> {
  // storage.local, not sync: the bearer token must not replicate through
  // browser cloud sync onto every signed-in profile.
  const stored = (await browser.storage.local.get(["serverUrl", "token", "device"])) as {
    serverUrl?: string;
    token?: string;
    device?: string;
  };
  return {
    serverUrl: (stored.serverUrl ?? "").replace(/\/$/, ""),
    token: stored.token ?? "",
    device: stored.device ?? "",
  };
}

export interface SaveArgs {
  url: string;
  note?: string;
  saved_from: "extension" | "context_menu";
  referrer?: string;
  archive_coming?: boolean; // server defers enrichment until the snapshot PUT
}

// Server unreachable (fetch itself rejected) — distinct from a server error
// response: these saves are queued locally and retried.
export class OfflineError extends Error {
  constructor() {
    super("Amber unreachable");
    this.name = "OfflineError";
  }
}

export interface SaveResult {
  id: string;
  duplicate?: boolean;
  saved_at?: number; // present on duplicates: when it was first saved
}

export async function saveBookmark(args: SaveArgs): Promise<SaveResult> {
  const settings = await getSettings();
  if (!settings.serverUrl || !settings.token) {
    throw new Error("not configured — open extension options");
  }
  let res: Response;
  try {
    res = await fetch(`${settings.serverUrl}/api/bookmarks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify({ ...args, device: settings.device || undefined }),
    });
  } catch {
    throw new OfflineError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ---- offline save queue -----------------------------------------------------
// A save must never be lost to a napping self-hosted server: failed saves park
// in storage.local and drain on the next action / alarm / browser start.

interface QueuedSave {
  args: SaveArgs;
  queued_at: number;
}

export async function enqueueOffline(args: SaveArgs): Promise<number> {
  const { amber_queue } = (await browser.storage.local.get("amber_queue")) as {
    amber_queue?: QueuedSave[];
  };
  const queue = amber_queue ?? [];
  // The moment is what matters; archive_coming can't survive a deferred save.
  queue.push({ args: { ...args, archive_coming: undefined }, queued_at: Date.now() });
  await browser.storage.local.set({ amber_queue: queue.slice(-200) });
  return queue.length;
}

// Drains the queue front-to-back; stops at the first offline failure (server
// still down). Server-side rejections (4xx) drop the item — retrying can't fix
// those. Returns how many saves went through.
export async function flushOfflineQueue(): Promise<number> {
  const { amber_queue } = (await browser.storage.local.get("amber_queue")) as {
    amber_queue?: QueuedSave[];
  };
  let queue = amber_queue ?? [];
  if (!queue.length) return 0;
  let flushed = 0;
  while (queue.length) {
    const item = queue[0];
    try {
      await saveBookmark(item.args);
      flushed++;
      queue = queue.slice(1);
    } catch (err) {
      if (err instanceof OfflineError) break;
      queue = queue.slice(1); // rejected by the server — drop, don't loop
    }
  }
  await browser.storage.local.set({ amber_queue: queue });
  return flushed;
}

export async function offlineQueueSize(): Promise<number> {
  const { amber_queue } = (await browser.storage.local.get("amber_queue")) as {
    amber_queue?: QueuedSave[];
  };
  return amber_queue?.length ?? 0;
}

// Kick off enrichment for a bookmark whose promised snapshot never made it —
// otherwise the server defers until the maintenance sweep notices (~2min).
export async function triggerEnrich(id: string): Promise<void> {
  const settings = await getSettings();
  await fetch(`${settings.serverUrl}/api/bookmarks/${id}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.token}` },
  }).catch(() => {});
}

// Upload a self-contained page snapshot captured in the tab. Best-effort:
// the bookmark exists either way; the archive just makes it permanent.
export async function uploadArchive(id: string, html: string): Promise<void> {
  const settings = await getSettings();
  const res = await fetch(`${settings.serverUrl}/api/bookmarks/${id}/archive`, {
    method: "PUT",
    headers: {
      "Content-Type": "text/html",
      Authorization: `Bearer ${settings.token}`,
    },
    body: html,
  });
  if (!res.ok) throw new Error(`archive upload HTTP ${res.status}`);
}

// Poll enrichment status ~2s until done; give up silently after ~24s
// (enrichment now waits for the snapshot upload, so allow extra time).
export async function waitForGist(id: string): Promise<string | null> {
  const settings = await getSettings();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${settings.serverUrl}/api/bookmarks/${id}/status`, {
        headers: { Authorization: `Bearer ${settings.token}` },
      });
      if (!res.ok) return null;
      const status = await res.json();
      if (status.enrich_status === "done") return status.gist ?? null;
      if (status.enrich_status === "failed") return null;
    } catch {
      return null;
    }
  }
  return null;
}
