import PQueue from "p-queue";

// Global outbound rate limit: imports of thousands of links must not hammer
// sites (design §5). ~2 requests/sec, 2 in flight.
const fetchQueue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 2 });

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_HTML_BYTES = 3 * 1024 * 1024;

export interface FetchedPage {
  finalUrl: string;
  html: string;
  contentType: string;
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  const result = await fetchQueue.add(async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { finalUrl: res.url || url, html, contentType: res.headers.get("content-type") ?? "" };
  });
  return result as FetchedPage;
}

export async function fetchJson(url: string): Promise<any> {
  const result = await fetchQueue.add(async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return result;
}
