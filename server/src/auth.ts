import type { MiddlewareHandler } from "hono";

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || provided !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
