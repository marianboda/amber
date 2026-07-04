import PQueue from "p-queue";
import { lookup } from "node:dns/promises";
import net from "node:net";

// ---- SSRF guard -----------------------------------------------------------
// The server fetches user-supplied URLs and asset URLs extracted from
// untrusted pages. Block anything that resolves to private/loopback/link-local
// space so a hostile page can't make Amber probe internal services.
// AMBER_ALLOW_PRIVATE=1 disables the guard for local development.

const allowPrivate = process.env.AMBER_ALLOW_PRIVATE === "1";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fe80") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd")
    );
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`blocked: ${url.protocol} url`);
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("blocked: private hostname");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked: private address");
    return url;
  }
  const { address } = await lookup(host);
  if (isPrivateIp(address)) throw new Error("blocked: private address");
  return url;
}

// fetch with manual redirect hops so every hop passes the SSRF check
// (a public URL redirecting to 169.254.169.254 must not be followed).
async function guardedFetch(rawUrl: string, init: RequestInit): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      res.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    // expose the final URL the way redirect:'follow' would
    Object.defineProperty(res, "url", { value: current });
    return res;
  }
  throw new Error("too many redirects");
}
// ---------------------------------------------------------------------------

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
    const res = await guardedFetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { finalUrl: res.url || url, html, contentType: res.headers.get("content-type") ?? "" };
  });
}

export async function fetchJson(url: string): Promise<any> {
  return schedule(url, async () => {
    const res = await guardedFetch(url, {
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
      const res = await guardedFetch(url, {
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
