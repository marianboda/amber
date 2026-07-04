// Shared client logic for talking to the Amber server from the extension.

export interface AmberSettings {
  serverUrl: string;
  token: string;
  device: string;
}

export async function getSettings(): Promise<AmberSettings> {
  const stored = (await browser.storage.sync.get(["serverUrl", "token", "device"])) as {
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
  const res = await fetch(`${settings.serverUrl}/api/bookmarks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify({ ...args, device: settings.device || undefined }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
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
