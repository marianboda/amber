import { saveBookmark, waitForGist, type SaveArgs } from "../lib/amber";

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
    await save(tab.id, { url: tab.url, note: note || undefined, saved_from: "extension" });
  });

  // Right-click a link → save that link, current page recorded as referrer.
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "save-link" || !info.linkUrl || !tab?.id) return;
    await save(tab.id, { url: info.linkUrl, referrer: tab.url, saved_from: "context_menu" });
  });

  async function save(tabId: number, args: SaveArgs) {
    try {
      const result = await saveBookmark(args);
      await toast(tabId, result.duplicate ? "Already in Amber" : "Saved ✓", "ok");
      if (!result.duplicate) {
        const gist = await waitForGist(result.id);
        if (gist) await toast(tabId, gist, "gist");
      }
    } catch (err: any) {
      await toast(tabId, `Amber: ${err.message}`, "error");
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
