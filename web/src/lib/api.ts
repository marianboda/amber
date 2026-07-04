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
  archive_ref: string | null;
  content_text: string | null;
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
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
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
  exportUrl: (format: "json" | "html" | "zip") => `/api/export?format=${format}`,
  retryFailed: () =>
    request("/bookmarks/retry-failed", { method: "POST" }) as Promise<{ retried: number }>,
  importList: () =>
    request("/import") as Promise<{
      imports: {
        job_id: string;
        status: string;
        filename: string;
        progress: { total: number; imported: number; duplicates: number; invalid: number } | null;
      }[];
    }>,
  importFile: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request("/import", { method: "POST", body: form }) as Promise<{
      job_id: string;
      count: number;
    }>;
  },
  importStatus: (jobId: string) =>
    request(`/import/${jobId}`) as Promise<{
      status: string;
      error: string | null;
      progress: { total: number; imported: number; duplicates: number; invalid: number } | null;
      enrichment: Record<string, number>;
    }>,
};
