import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

// Simple brute-force guard: after 20 bad tokens from one IP within a minute,
// reject with 429 until the window passes.
const failures = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60_000;
const MAX_FAILURES = 20;

function tooManyFailures(ip: string): boolean {
  const entry = failures.get(ip);
  return !!entry && Date.now() - entry.windowStart < WINDOW_MS && entry.count >= MAX_FAILURES;
}

function recordFailure(ip: string) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    failures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
  if (failures.size > 10_000) failures.clear(); // memory backstop
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      (c.env as any)?.incoming?.socket?.remoteAddress ??
      "unknown";
    if (tooManyFailures(ip)) return c.json({ error: "too many attempts" }, 429);
    const header = c.req.header("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !tokensMatch(provided, token)) {
      recordFailure(ip);
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
