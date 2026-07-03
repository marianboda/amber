export interface Topic {
  id: string;
  name: string;
  color: string | null;
  count?: number;
  by_ai?: number;
}

export interface Bookmark {
  id: string;
  url: string;
  canonical_url: string | null;
  title: string | null;
  domain: string | null;
  favicon_url: string | null;
  og_image_url: string | null;
  saved_at: number;
  content_type: string | null;
  gist: string | null;
  summary: string | null;
  note: string | null;
  is_read: number;
  saved_from: string | null;
  device: string | null;
  referrer: string | null;
  source_detail: string | null;
  enrich_status: "pending" | "done" | "failed";
  fetch_status: "pending" | "ok" | "dead";
  topics: Topic[];
}

export function getToken(): string {
  return localStorage.getItem("amber_token") ?? "";
}

export function setToken(token: string) {
  localStorage.setItem("amber_token", token);
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  ping: () => request("/ping"),
  list: (params: Record<string, string>) =>
    request(`/bookmarks?${new URLSearchParams(params)}`) as Promise<{
      bookmarks: Bookmark[];
      next_before: number | null;
    }>,
  get: (id: string) => request(`/bookmarks/${id}`) as Promise<Bookmark>,
  status: (id: string) =>
    request(`/bookmarks/${id}/status`) as Promise<{
      id: string;
      enrich_status: string;
      fetch_status: string;
      gist: string | null;
    }>,
  patch: (id: string, body: object) =>
    request(`/bookmarks/${id}`, { method: "PATCH", body: JSON.stringify(body) }) as Promise<Bookmark>,
  remove: (id: string) => request(`/bookmarks/${id}`, { method: "DELETE" }),
  retry: (id: string) => request(`/bookmarks/${id}/retry`, { method: "POST" }),
  save: (url: string) =>
    request("/bookmarks", {
      method: "POST",
      body: JSON.stringify({ url, saved_from: "api", source_detail: "web-ui" }),
    }),
  topics: () => request("/topics") as Promise<{ topics: Topic[] }>,
  exportUrl: (format: "json" | "html") => `/api/export?format=${format}`,
};
