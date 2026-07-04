import { Defuddle } from "defuddle/node";

export interface ExtractedPage {
  title: string | null;
  description: string | null;
  favicon: string | null;
  image: string | null;
  text: string | null; // plain text of the main content
}

export async function extractPage(html: string, url: string): Promise<ExtractedPage> {
  const result = await Defuddle(html, url, { markdown: false });
  const text = result.content ? htmlToText(result.content) : null;
  return {
    title: result.title || null,
    description: result.description || null,
    favicon: absolute(result.favicon, url),
    image: absolute(result.image, url),
    text: text && text.trim().length > 0 ? text : null,
  };
}

// Defuddle can return page-relative asset URLs; resolve against the page.
function absolute(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  if (value.startsWith("data:")) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
