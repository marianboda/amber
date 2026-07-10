import {
  saveBookmark,
  waitForGist,
  uploadArchive,
  triggerEnrich,
  enqueueOffline,
  flushOfflineQueue,
  offlineQueueSize,
  OfflineError,
  type SaveArgs,
} from "../lib/amber";

const CAPTURE_TIMEOUT_MS = 30_000;

export default defineBackground(() => {
  // Firefox MV2 exposes browserAction instead of action.
  const action = browser.action ?? (browser as any).browserAction;

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: "save-page", title: "Save page to Amber", contexts: ["page"] });
    browser.contextMenus.create({ id: "save-link", title: "Save to Amber", contexts: ["link"] });
    browser.contextMenus.create({
      id: "save-selection",
      title: "Save page to Amber (selection as note)",
      contexts: ["selection"],
    });
  });

  // Queued offline saves drain on browser start and on a low-frequency alarm.
  flushQueue();
  browser.alarms?.create("amber-flush", { periodInMinutes: 5 });
  browser.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === "amber-flush") flushQueue();
  });

  async function flushQueue(tabId?: number) {
    if ((await offlineQueueSize()) === 0) return;
    const flushed = await flushOfflineQueue();
    if (flushed && tabId) await toast(tabId, `Amber: ${flushed} queued save(s) sent ✓`, "ok");
  }

  // Toolbar click / keyboard shortcut: save current tab, selection becomes note.
  action.onClicked.addListener(async (tab) => {
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return;
    await savePage(tab.id, tab.url, undefined);
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === "save-link" && info.linkUrl) {
      await save(tab.id, { url: info.linkUrl, referrer: tab.url, saved_from: "context_menu" });
    } else if (info.menuItemId === "save-page" && tab.url && /^https?:/.test(tab.url)) {
      await savePage(tab.id, tab.url, undefined);
    } else if (info.menuItemId === "save-selection" && tab.url && /^https?:/.test(tab.url)) {
      await savePage(tab.id, tab.url, info.selectionText || undefined);
    }
  });

  // Full current-page save: bookmark + rendered-page snapshot (works behind
  // logins, survives dead URLs). Duplicates skip capture — the original
  // snapshot is the preserved one (permanence: nothing gets overwritten).
  async function savePage(tabId: number, url: string, noteOverride: string | undefined) {
    const note = noteOverride ?? (await getSelection(tabId));
    const saved = await save(tabId, {
      url,
      note: note || undefined,
      saved_from: "extension",
      archive_coming: true,
    });
    if (saved && !saved.duplicate) await captureAndUpload(tabId, saved.id, url);
  }

  async function save(tabId: number, args: SaveArgs) {
    try {
      const result = await saveBookmark(args);
      const dupText = result.saved_at
        ? `Already in Amber — first saved ${new Date(result.saved_at * 1000).toLocaleDateString()}`
        : "Already in Amber";
      await toast(tabId, result.duplicate ? dupText : "Saved ✓", "ok");
      if (!result.duplicate) {
        waitForGist(result.id).then((gist) => {
          if (gist) toast(tabId, gist, "gist");
        });
      }
      flushQueue(tabId); // server clearly reachable — drain any parked saves
      return result;
    } catch (err: any) {
      if (err instanceof OfflineError) {
        const depth = await enqueueOffline(args);
        await toast(tabId, `Amber unreachable — queued (${depth}), will retry`, "error");
      } else if (String(err.message).includes("not configured")) {
        await toast(tabId, "Amber: not configured", "error");
        browser.runtime.openOptionsPage().catch(() => {});
      } else {
        await toast(tabId, `Amber: ${err.message}`, "error");
      }
      return null;
    }
  }

  async function captureAndUpload(tabId: number, bookmarkId: string, expectedUrl: string) {
    try {
      // If the user navigated after clicking, don't archive the new page under
      // the old bookmark — bail unless the tab is still on the saved URL.
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab || tab.url !== expectedUrl) {
        await triggerEnrich(bookmarkId); // we promised a snapshot; release the deferral
        return;
      }
      // Frames listener first (all frames), then the top-frame capturer.
      await browser.scripting
        .executeScript({ target: { tabId, allFrames: true }, files: ["/capture-frames.js"] })
        .catch(() => {}); // cross-origin frame injection can fail; capture still works without
      await browser.scripting.executeScript({ target: { tabId }, files: ["/capture.js"] });
      // Pathological pages can wedge single-file (deferred images that never
      // settle) — cap the wait and fall back to no-archive enrichment.
      const captured = browser.scripting.executeScript({
        target: { tabId },
        func: () => (globalThis as any).__amberCapture(),
      });
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)
      );
      const results = await Promise.race([captured, timeout]);
      const html = results?.[0]?.result as string | undefined;
      if (!html) {
        await triggerEnrich(bookmarkId);
        return;
      }
      try {
        await uploadArchive(bookmarkId, html);
      } catch {
        // One retry — a big snapshot on flaky wifi is the common case here.
        await new Promise((r) => setTimeout(r, 2000));
        await uploadArchive(bookmarkId, html);
      }
    } catch {
      // Archive is best-effort; the bookmark itself already saved. But the
      // server is still waiting on our promised snapshot — start enrichment.
      await triggerEnrich(bookmarkId);
    }
  }

  async function getSelection(tabId: number): Promise<string> {
    try {
      const [result] = await browser.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection()?.toString() ?? "",
      });
      return (result?.result as string) ?? "";
    } catch {
      return ""; // restricted page (chrome://, PDF viewer, …)
    }
  }

  async function toast(tabId: number, text: string, state: "ok" | "gist" | "error") {
    try {
      await browser.tabs.sendMessage(tabId, { type: "amber-toast", text, state });
    } catch {
      // No content script on this page — fall back to a badge.
      await action.setBadgeText({ text: state === "error" ? "!" : "✓", tabId });
      setTimeout(() => action.setBadgeText({ text: "", tabId }).catch(() => {}), 4000);
    }
  }
});
