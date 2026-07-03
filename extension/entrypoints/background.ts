import { saveBookmark, waitForGist, uploadArchive, type SaveArgs } from "../lib/amber";

export default defineBackground(() => {
  // Firefox MV2 exposes browserAction instead of action.
  const action = browser.action ?? (browser as any).browserAction;

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: "save-link",
      title: "Save to Amber",
      contexts: ["link"],
    });
  });

  // Toolbar click / keyboard shortcut: save current tab, selection becomes note.
  action.onClicked.addListener(async (tab) => {
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return;
    const note = await getSelection(tab.id);
    const saved = await save(tab.id, {
      url: tab.url,
      note: note || undefined,
      saved_from: "extension",
    });
    // Archive the rendered page (assets inlined) — works behind logins and
    // survives dead URLs. Runs after the save toast; best-effort.
    if (saved) await captureAndUpload(tab.id, saved);
  });

  // Right-click a link → save that link, current page recorded as referrer.
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "save-link" || !info.linkUrl || !tab?.id) return;
    await save(tab.id, { url: info.linkUrl, referrer: tab.url, saved_from: "context_menu" });
  });

  async function save(tabId: number, args: SaveArgs): Promise<string | null> {
    try {
      const result = await saveBookmark(args);
      await toast(tabId, result.duplicate ? "Already in Amber" : "Saved ✓", "ok");
      if (!result.duplicate) {
        waitForGist(result.id).then((gist) => {
          if (gist) toast(tabId, gist, "gist");
        });
      }
      return result.id;
    } catch (err: any) {
      await toast(tabId, `Amber: ${err.message}`, "error");
      return null;
    }
  }

  async function captureAndUpload(tabId: number, bookmarkId: string) {
    try {
      // Frames listener first (all frames), then the top-frame capturer.
      await browser.scripting
        .executeScript({ target: { tabId, allFrames: true }, files: ["/capture-frames.js"] })
        .catch(() => {}); // cross-origin frame injection can fail; capture still works without
      await browser.scripting.executeScript({ target: { tabId }, files: ["/capture.js"] });
      const [result] = await browser.scripting.executeScript({
        target: { tabId },
        func: () => (globalThis as any).__amberCapture(),
      });
      const html = result?.result as string | undefined;
      if (html) await uploadArchive(bookmarkId, html);
    } catch {
      // Archive is best-effort; the bookmark itself already saved.
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
