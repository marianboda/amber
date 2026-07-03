export const TYPE_ICONS: Record<string, string> = {
  article: "📄",
  tool: "🔧",
  video: "🎬",
  repo: "📦",
  paper: "📑",
  thread: "💬",
  product: "🛍️",
  other: "🔖",
};

export const CONTENT_TYPES = Object.keys(TYPE_ICONS);

export function relativeDate(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}

// Deterministic pastel tile color from the domain, for cards without og_image.
export function domainColor(domain: string | null): string {
  let hash = 0;
  for (const ch of domain ?? "?") hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 82%)`;
}

export function provenance(b: {
  saved_from: string | null;
  device: string | null;
  referrer: string | null;
  source_detail: string | null;
}): string {
  const parts: string[] = [];
  const from: Record<string, string> = {
    extension: "via extension",
    share_sheet: "via share sheet",
    context_menu: "via context menu",
    import: "imported",
    api: "via API",
  };
  if (b.device) parts.push(`saved from ${b.device}`);
  if (b.saved_from) parts.push(from[b.saved_from] ?? b.saved_from);
  if (b.source_detail) parts.push(`(${b.source_detail})`);
  if (b.referrer) parts.push(`· found on ${new URL(b.referrer).hostname}`);
  return parts.join(" ");
}
