import PQueue from "p-queue";
import { lookup } from "node:dns/promises";
import { lookup as lookupCb } from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { readStreamLimited } from "../http-util.js";

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

// Pins the SSRF check to the ACTUAL socket target: the same lookup that
// validates the address is the one undici connects with, so a rebinding host
// that answers public-then-private can't slip past the pre-check. Multi-answer
// DNS is covered too — every returned address is validated.
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = addresses as { address: string; family: number }[];
        if (!allowPrivate) {
          const bad = list.find((a) => isPrivateIp(a.address));
          if (bad) return callback(new Error(`blocked: private address ${bad.address}`), "", 0);
        }
        if ((options as any).all) return callback(null, list as any, undefined as any);
        callback(null, list[0].address, list[0].family);
      });
    },
  },
});

// fetch with manual redirect hops so every hop passes the SSRF check
// (a public URL redirecting to 169.254.169.254 must not be followed).
// Uses undici's own fetch so the Agent (also from undici) is compatible —
// Node's built-in fetch is a separate undici copy and rejects this dispatcher.
async function guardedFetch(
  rawUrl: string,
  init: UndiciRequestInit
): Promise<import("undici").Response> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const res = await undiciFetch(current, {
      ...init,
      redirect: "manual",
      dispatcher: guardedAgent,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      res.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
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

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;

export interface FetchedPage {
  finalUrl: string;
  html: string;
  contentType: string;
  // false = the URL is a PDF/image/binary: html holds no parseable markup and
  // must not be fed to extraction or FTS.
  isHtml: boolean;
}

// Decode using the declared charset (Content-Type header, then <meta charset>
// / http-equiv sniffed from the first bytes). ISO-8859-2 pages are common on
// .sk/.cz sites — utf8-decoding those puts mojibake in titles and FTS.
export function decodeHtml(bytes: Buffer, contentTypeHeader: string): string {
  let charset = contentTypeHeader.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    const head = bytes.subarray(0, 2048).toString("latin1");
    charset =
      head.match(/<meta\s+charset=["']?([\w-]+)/i)?.[1] ??
      head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)?.[1];
  }
  if (charset && !/^(utf-?8)$/i.test(charset)) {
    try {
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      /* unknown label — fall through to utf-8 */
    }
  }
  return bytes.toString("utf8");
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  return schedule(url, async () => {
    const res = await guardedFetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    // Missing header: assume HTML (most common for pages that omit it).
    const isHtml = contentType === "" || HTML_TYPES.test(contentType);
    if (!isHtml) {
      // PDF/image/binary — don't buffer megabytes we won't parse.
      res.body?.cancel().catch(() => {});
      return { finalUrl: res.url || url, html: "", contentType, isHtml };
    }
    // Stream-limited: an endless/huge response is cut off at MAX_HTML_BYTES
    // instead of being buffered whole.
    const bytes = await readStreamLimited(res.body as any, MAX_HTML_BYTES);
    const html = decodeHtml(bytes ?? Buffer.alloc(0), contentType);
    return { finalUrl: res.url || url, html, contentType, isHtml };
  });
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;

export async function fetchJson(url: string): Promise<any> {
  return schedule(url, async () => {
    const res = await guardedFetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The only fetch path that buffered unbounded — cap it like the others.
    const bytes = await readStreamLimited(res.body as any, MAX_JSON_BYTES);
    if (bytes === null) throw new Error("json response too large");
    return JSON.parse(bytes.toString("utf8"));
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
      const buffer = await readStreamLimited(res.body as any, MAX_ASSET_BYTES);
      if (buffer === null) throw new Error("asset too large");
      return { bytes: buffer, contentType: res.headers.get("content-type") ?? "" };
    });
  } catch {
    return null;
  }
}
