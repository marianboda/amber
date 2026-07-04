import PQueue from "p-queue";

// Two-level outbound rate limiting (design §5):
// - global cap so imports never blast the network,
// - per-host serialization so one slow site can't starve the rest and no
//   single origin sees more than ~1 req/s.
const globalQueue = new PQueue({ concurrency: 6 });
const hostQueues = new Map<string, PQueue>();

function hostQueue(url: string): PQueue {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = "?";
  }
  let queue = hostQueues.get(host);
  if (!queue) {
    queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });
    hostQueues.set(host, queue);
    // Don't leak one queue per dead domain forever.
    if (hostQueues.size > 500) {
      for (const [key, q] of hostQueues) {
        if (q.size === 0 && q.pending === 0) hostQueues.delete(key);
        if (hostQueues.size <= 250) break;
      }
    }
  }
  return queue;
}

function schedule<T>(url: string, task: () => Promise<T>): Promise<T> {
  return hostQueue(url).add(() => globalQueue.add(task)) as Promise<T>;
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_HTML_BYTES = 3 * 1024 * 1024;

export interface FetchedPage {
  finalUrl: string;
  html: string;
  contentType: string;
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  return schedule(url, async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { finalUrl: res.url || url, html, contentType: res.headers.get("content-type") ?? "" };
  });
}

export async function fetchJson(url: string): Promise<any> {
  return schedule(url, async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

const MAX_ASSET_BYTES = 5 * 1024 * 1024;

// Small binary fetch for thumbnails/favicons.
export async function fetchAsset(
  url: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    return await schedule(url, async () => {
      const res = await fetch(url, {
        headers: { "User-Agent": DESKTOP_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_ASSET_BYTES) throw new Error("asset too large");
      return { bytes: buffer, contentType: res.headers.get("content-type") ?? "" };
    });
  } catch {
    return null;
  }
}
