import { describe, it, expect, vi, afterEach } from "vitest";
import { relativeDate, domainColor, provenance, TYPE_ICONS, CONTENT_TYPES } from "./format";

afterEach(() => vi.useRealTimers());

describe("relativeDate", () => {
  it("buckets ages into now/m/h/d/mo/y", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const now = Date.now() / 1000;
    expect(relativeDate(now - 30)).toBe("now");
    expect(relativeDate(now - 90)).toBe("1m");
    expect(relativeDate(now - 2 * 3600)).toBe("2h");
    expect(relativeDate(now - 3 * 86400)).toBe("3d");
    expect(relativeDate(now - 45 * 86400)).toBe("1mo");
    expect(relativeDate(now - 800 * 86400)).toBe("2y");
  });
});

describe("domainColor", () => {
  it("is deterministic and always a valid hsl pastel", () => {
    expect(domainColor("example.com")).toBe(domainColor("example.com"));
    expect(domainColor("example.com")).not.toBe(domainColor("other.org"));
    expect(domainColor(null)).toMatch(/^hsl\(\d+ 45% 82%\)$/);
    expect(domainColor("Ω.emoji.🚀")).toMatch(/^hsl\(\d+ 45% 82%\)$/);
  });
});

describe("provenance", () => {
  it("assembles device, source, detail and referrer", () => {
    expect(
      provenance({
        saved_from: "extension",
        device: "mac-mini",
        referrer: "https://news.ycombinator.com/item?id=1",
        source_detail: null,
      })
    ).toBe("saved from mac-mini via extension · found on news.ycombinator.com");
    expect(
      provenance({ saved_from: "import", device: null, referrer: null, source_detail: "chrome.html" })
    ).toBe("imported (chrome.html)");
    expect(provenance({ saved_from: null, device: null, referrer: null, source_detail: null })).toBe("");
  });
});

describe("type registry", () => {
  it("CONTENT_TYPES mirrors TYPE_ICONS keys", () => {
    expect(CONTENT_TYPES).toEqual(Object.keys(TYPE_ICONS));
    expect(CONTENT_TYPES).toContain("article");
  });
});
