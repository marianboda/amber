import { JSDOM } from "jsdom";

export interface ImportItem {
  url: string;
  title: string | null;
  addDate: number | null; // unix seconds, from ADD_DATE
  folder: string | null; // "Dev/Tools" — kept as classification hint only
}

export function detectFormat(text: string): "netscape" | "lines" {
  return /<a\s+[^>]*href=/i.test(text) || /<dl/i.test(text) ? "netscape" : "lines";
}

// Netscape bookmark HTML (Chrome/Firefox/Safari exports). Browsers emit
// unclosed <DT>/<p> tags; jsdom normalizes them, so we walk the resulting DOM
// tracking the H3 folder labels that precede each <DL> block.
export function parseNetscape(html: string): ImportItem[] {
  const doc = new JSDOM(html).window.document;
  const items: ImportItem[] = [];
  const root = doc.querySelector("dl") ?? doc.body;
  walkContainer(root, [], items);
  return items;
}

function walkContainer(container: Element, path: string[], items: ImportItem[]) {
  let pendingFolder: string | null = null;

  function processNode(node: Element) {
    switch (node.tagName) {
      case "H3":
        pendingFolder = node.textContent?.trim() || null;
        break;
      case "DL":
        walkContainer(node, pendingFolder ? [...path, pendingFolder] : path, items);
        pendingFolder = null;
        break;
      case "A": {
        const url = node.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(url)) {
          const addDate = Number(node.getAttribute("add_date"));
          items.push({
            url,
            title: node.textContent?.trim() || null,
            addDate: Number.isFinite(addDate) && addDate > 0 ? normalizeEpoch(addDate) : null,
            folder: path.length ? path.join("/") : null,
          });
        }
        break;
      }
      default:
        for (const child of Array.from(node.children)) processNode(child);
    }
  }

  for (const child of Array.from(container.children)) processNode(child);
}

// Some exports use microseconds or milliseconds; normalize to seconds.
function normalizeEpoch(value: number): number {
  if (value > 1e15) return Math.floor(value / 1e6);
  if (value > 1e12) return Math.floor(value / 1e3);
  return value;
}

// CSV / plain URL list fallback: one bookmark per line, first http(s) field
// wins, remaining non-URL field (if any) becomes the title.
export function parseLines(text: string): ImportItem[] {
  const items: ImportItem[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/[,;\t]/).map((f) => f.trim().replace(/^"|"$/g, ""));
    const url = fields.find((f) => /^https?:\/\//i.test(f));
    if (!url) continue;
    const title = fields.find((f) => f && f !== url && !/^https?:\/\//i.test(f)) ?? null;
    items.push({ url, title, addDate: null, folder: null });
  }
  return items;
}
