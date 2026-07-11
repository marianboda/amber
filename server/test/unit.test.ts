import { describe, it, expect } from "vitest";
import { canonicalize, domainOf } from "../src/canonical.js";
import { ftsQuery, scrubScripts } from "../src/routes/bookmarks.js";
import { translate } from "../src/db.js";
import { parseNetscape, parseLines, detectFormat } from "../src/import/parse.js";
import { dedupeItems } from "../src/import/run.js";
import { isYouTube } from "../src/pipeline/youtube.js";

describe("canonicalize", () => {
  it("strips tracking params, keeps real ones", () => {
    expect(canonicalize("https://a.com/x?utm_source=t&id=2&fbclid=z")).toBe("https://a.com/x?id=2");
  });
  it("rejects non-http(s) protocols", () => {
    expect(() => canonicalize("javascript:alert(1)")).toThrow();
    expect(() => canonicalize("data:text/html,<script>x</script>")).toThrow();
    expect(() => canonicalize("file:///etc/passwd")).toThrow();
  });
  it("sorts params, drops hash and trailing slash, lowercases host", () => {
    expect(canonicalize("https://A.com/p/?b=2&a=1#frag")).toBe("https://a.com/p?a=1&b=2");
  });
  it("keeps root slash", () => {
    expect(canonicalize("https://a.com/")).toBe("https://a.com/");
  });
  it("domainOf strips www", () => {
    expect(domainOf("https://www.Example.com/x")).toBe("example.com");
  });
});

describe("ftsQuery", () => {
  it("builds ANDed prefix lexemes for tsquery", () => {
    expect(ftsQuery("rust async")).toBe("rust:* & async:*");
  });
  it("splits on punctuation so tsquery operators can't inject", () => {
    expect(ftsQuery('a OR "b')).toBe("a:* & OR:* & b:*");
    expect(ftsQuery("!(a|b)")).toBe("a:* & b:*");
    expect(ftsQuery("unique-fts-token")).toBe("unique:* & fts:* & token:*");
  });
  it("returns null for whitespace/punctuation only", () => {
    expect(ftsQuery("   ")).toBeNull();
    expect(ftsQuery("!|()")).toBeNull();
  });
});

describe("translate (? → $n)", () => {
  it("numbers placeholders left to right", () => {
    expect(translate("SELECT ? WHERE a = ? AND b = ?")).toBe("SELECT $1 WHERE a = $2 AND b = $3");
  });
  it("ignores ? inside single-quoted strings (incl. doubled '')", () => {
    expect(translate("WHERE note = '' OR x = ? OR y = 'a?b'")).toBe(
      "WHERE note = '' OR x = $1 OR y = 'a?b'"
    );
  });
  it("ignores ? in double-quoted identifiers, comments, and dollar-quotes", () => {
    expect(translate('SELECT "we?rd" , ? FROM t')).toBe('SELECT "we?rd" , $1 FROM t');
    expect(translate("SELECT ? -- trailing ? comment\n, ?")).toBe(
      "SELECT $1 -- trailing ? comment\n, $2"
    );
    expect(translate("SELECT ? /* ? */ , ?")).toBe("SELECT $1 /* ? */ , $2");
    expect(translate("SELECT $$ a?b $$, ?")).toBe("SELECT $$ a?b $$, $1");
  });
});

describe("scrubScripts", () => {
  it("removes script tags, handlers, javascript: urls", () => {
    const dirty =
      '<body onload="evil()"><script>steal()</script><script src="x.js"></script>' +
      '<a href="javascript:bad()">x</a><p onclick=\'h()\'>t</p><img src="data:image/png;base64,AA">';
    const clean = scrubScripts(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onload|onclick/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('src="data:image/png;base64,AA"');
  });
});

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Dev</H3>
  <DL><p>
    <DT><A HREF="https://a.com/1" ADD_DATE="1500000000">One</A>
    <DT><H3>Tools</H3>
    <DL><p>
      <DT><A HREF="https://a.com/2" ADD_DATE="1600000000000">Two ms-epoch</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="https://a.com/3">Three root</A>
  <DT><A HREF="ftp://skip.me">nope</A>
</DL><p>`;

describe("parseNetscape", () => {
  const items = parseNetscape(NETSCAPE);
  it("finds http links only", () => {
    expect(items).toHaveLength(3);
  });
  it("tracks nested folder paths", () => {
    expect(items.find((i) => i.url.endsWith("/2"))?.folder).toBe("Dev/Tools");
    expect(items.find((i) => i.url.endsWith("/3"))?.folder).toBeNull();
  });
  it("normalizes ms epochs to seconds", () => {
    expect(items.find((i) => i.url.endsWith("/2"))?.addDate).toBe(1600000000);
  });
});

describe("parseLines", () => {
  it("handles csv with titles and comments", () => {
    const items = parseLines("https://a.com/x,Title A\n# comment\nhttps://b.com/y\n\n");
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Title A");
    expect(items[1].title).toBeNull();
  });
  it("detectFormat picks netscape for html", () => {
    expect(detectFormat(NETSCAPE)).toBe("netscape");
    expect(detectFormat("https://a.com\n")).toBe("lines");
  });
});

describe("dedupeItems", () => {
  it("keeps earliest date per canonical url", () => {
    const { items } = dedupeItems([
      { url: "https://a.com/x?utm_source=1", title: "new", addDate: 200, folder: null },
      { url: "https://a.com/x", title: "old", addDate: 100, folder: null },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].addDate).toBe(100);
  });
});

describe("isYouTube", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abc", true],
    ["https://youtu.be/abc", true],
    ["https://m.youtube.com/shorts/abc", true],
    ["https://youtube.com/playlist?list=x", false],
    ["https://vimeo.com/123", false],
  ])("%s → %s", (url, expected) => {
    expect(isYouTube(url)).toBe(expected);
  });
});
