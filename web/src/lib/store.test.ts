// Tests the pure URL <-> state sync helpers. The .svelte.ts store compiles
// through the Svelte Vite plugin, so $state works here.
import { describe, it, expect, beforeEach } from "vitest";
import { store, applyHash, buildHash } from "./store.svelte";

function resetStore() {
  store.q = "";
  store.type = "";
  store.topic = "";
  store.domain = "";
  store.read = "";
  store.sort = "";
  store.view = "grid";
  store.detailId = null;
  store.page = "library";
}

beforeEach(resetStore);

describe("buildHash / applyHash round trip", () => {
  it("serializes only non-default state", () => {
    expect(buildHash()).toBe("");
    store.q = "rust async";
    store.read = "0";
    store.detailId = "abc-123";
    const hash = buildHash();
    expect(hash).toContain("q=rust+async");
    expect(hash).toContain("read=0");
    expect(hash).toContain("detail=abc-123");
    expect(hash).not.toContain("view=");
  });

  it("applies a hash back onto the store and reports filter changes", () => {
    const changed = applyHash("#q=svelte&topic=dev&view=list&detail=x1&page=library");
    expect(changed).toBe(true);
    expect(store.q).toBe("svelte");
    expect(store.topic).toBe("dev");
    expect(store.view).toBe("list");
    expect(store.detailId).toBe("x1");
  });

  it("round-trips exactly", () => {
    store.q = "čaj & med";
    store.domain = "example.com";
    store.sort = "oldest";
    store.view = "list";
    const hash = buildHash();
    resetStore();
    applyHash(hash);
    expect(store.q).toBe("čaj & med");
    expect(store.domain).toBe("example.com");
    expect(store.sort).toBe("oldest");
    expect(store.view).toBe("list");
    expect(buildHash()).toBe(hash);
  });

  it("detail-only changes report no filter change (no reload needed)", () => {
    applyHash("#q=x");
    expect(applyHash("#q=x&detail=abc")).toBe(false);
    expect(store.detailId).toBe("abc");
    expect(applyHash("#q=y&detail=abc")).toBe(true);
  });

  it("ignores junk values safely", () => {
    applyHash("#view=bogus&page=bogus&read=7");
    expect(store.view).toBe("grid");
    expect(store.page).toBe("library");
  });
});
