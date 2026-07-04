// Cheap, offline URL canonicalization used at save time for dedup.
// Network-level normalization (redirect resolution) happens later in the pipeline.

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "s_kwcid",
]);

function isTrackingParam(name: string): boolean {
  return name.startsWith("utm_") || TRACKING_PARAMS.has(name);
}

export function canonicalize(rawUrl: string): string {
  const u = new URL(rawUrl);
  // Only web URLs are storable — javascript:/data:/file: would become an XSS
  // vector the moment the UI renders them as an href or window.open target.
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${u.protocol}`);
  }
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  for (const name of [...u.searchParams.keys()]) {
    if (isTrackingParam(name)) u.searchParams.delete(name);
  }
  u.searchParams.sort();
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

export function domainOf(rawUrl: string): string {
  return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
}
