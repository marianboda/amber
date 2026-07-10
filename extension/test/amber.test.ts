import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for browser.storage.local — amber.ts only uses get/set.
const storageData: Record<string, unknown> = {};
(globalThis as any).browser = {
  storage: {
    local: {
      async get(keys: string | string[]) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map((k) => [k, storageData[k]]));
      },
      async set(values: Record<string, unknown>) {
        Object.assign(storageData, values);
      },
    },
  },
};

const { saveBookmark, enqueueOffline, flushOfflineQueue, offlineQueueSize, OfflineError } =
  await import("../lib/amber");

function configure() {
  storageData.serverUrl = "https://amber.test";
  storageData.token = "tok";
  storageData.device = "test-device";
}

beforeEach(() => {
  for (const k of Object.keys(storageData)) delete storageData[k];
  vi.unstubAllGlobals();
});

describe("saveBookmark", () => {
  it("throws OfflineError when fetch itself fails", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(saveBookmark({ url: "https://x.test", saved_from: "extension" })).rejects.toBeInstanceOf(
      OfflineError
    );
  });

  it("throws a normal error on server rejection (no offline queueing)", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid url" }), { status: 400 }))
    );
    await expect(saveBookmark({ url: "bad", saved_from: "extension" })).rejects.toThrow("invalid url");
  });

  it("demands configuration before any network call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(saveBookmark({ url: "https://x.test", saved_from: "extension" })).rejects.toThrow(
      /not configured/
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("offline queue", () => {
  it("parks failed saves and drains them once the server is back", async () => {
    configure();
    await enqueueOffline({ url: "https://a.test/1", saved_from: "extension", archive_coming: true });
    await enqueueOffline({ url: "https://a.test/2", saved_from: "context_menu" });
    expect(await offlineQueueSize()).toBe(2);

    const calls: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "id-" + calls.length }), { status: 201 });
      })
    );
    expect(await flushOfflineQueue()).toBe(2);
    expect(await offlineQueueSize()).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["https://a.test/1", "https://a.test/2"]);
    // archive_coming must not survive a deferred save — no snapshot is coming.
    expect(calls[0].archive_coming).toBeUndefined();
  });

  it("stops draining while still offline, keeps items", async () => {
    configure();
    await enqueueOffline({ url: "https://a.test/1", saved_from: "extension" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("still down")));
    expect(await flushOfflineQueue()).toBe(0);
    expect(await offlineQueueSize()).toBe(1);
  });

  it("drops items the server rejects instead of looping forever", async () => {
    configure();
    await enqueueOffline({ url: "rejected", saved_from: "extension" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid url" }), { status: 400 }))
    );
    expect(await flushOfflineQueue()).toBe(0);
    expect(await offlineQueueSize()).toBe(0);
  });
});
