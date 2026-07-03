import type { Config } from "../config.js";
import { fetchJson } from "./fetcher.js";
import { CONTENT_TYPES, type Enrichment } from "./llm.js";

export function isYouTube(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return true;
    return (
      (host === "youtube.com" || host === "m.youtube.com") &&
      (u.pathname === "/watch" || u.pathname.startsWith("/shorts/"))
    );
  } catch {
    return false;
  }
}

export interface OEmbed {
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
}

export async function fetchOEmbed(url: string): Promise<OEmbed | null> {
  try {
    const data = await fetchJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    );
    return {
      title: data?.title ?? null,
      channel: data?.author_name ?? null,
      thumbnail: data?.thumbnail_url ?? null,
    };
  } catch {
    return null;
  }
}

// Gemini accepts YouTube URLs natively (design §5). Returns null when no
// Gemini key is configured — caller falls back to the standard LLM path
// using oEmbed title/channel as input.
export async function enrichYouTubeWithGemini(
  config: Config,
  url: string,
  topicNames: string[]
): Promise<Enrichment | null> {
  if (!config.geminiApiKey) return null;
  const model = "gemini-2.0-flash";
  const topicPart = topicNames.length
    ? `topics: choose 1-3 ONLY from: ${topicNames.join(", ")}. If nothing fits, ["unsorted"].`
    : `topics: always return an empty array [].`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { file_uri: url } },
              {
                text: `Summarize this video for a personal bookmark library (owner: software developer).
Respond ONLY with JSON: {"gist": "", "summary": "", "topics": [""], "content_type": "video"}
gist: ONE sentence, max 120 characters. summary: one paragraph, 3-5 short sentences.
${topicPart}`,
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(120_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  const raw = JSON.parse(text);
  const vocab = new Set(topicNames);
  return {
    gist: String(raw.gist ?? "").slice(0, 200),
    summary: String(raw.summary ?? ""),
    content_type: CONTENT_TYPES.includes(raw.content_type) ? raw.content_type : "video",
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t: string) => vocab.has(t)) : [],
  };
}
