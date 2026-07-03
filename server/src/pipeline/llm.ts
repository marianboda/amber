import PQueue from "p-queue";
import type { Config } from "../config.js";

// Rate-limit LLM calls independently of page fetches (design §5).
const llmQueue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 2 });

export const CONTENT_TYPES = [
  "article",
  "tool",
  "video",
  "repo",
  "paper",
  "thread",
  "product",
  "other",
] as const;

export interface Enrichment {
  gist: string;
  summary: string;
  content_type: string;
  topics: string[];
}

export interface EnrichInput {
  title: string | null;
  url: string;
  text: string | null;
  topicHint: string | null;
  topicNames: string[]; // empty pre-bootstrap → classification omitted (design §5)
}

const MAX_INPUT_CHARS = 16_000; // ~4k tokens

function baseUrlFor(cfg: Config["llm"]): string {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, "");
  switch (cfg.provider) {
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "ollama":
      return "http://localhost:11434/v1";
    default:
      return "https://api.openai.com/v1";
  }
}

function buildSystemPrompt(topicNames: string[]): string {
  const topicPart = topicNames.length
    ? `TOPICS — choose 1–3 ONLY from this list: ${topicNames.join(", ")}.
If nothing fits confidently, use ["unsorted"].`
    : `topics: always return an empty array [] (no vocabulary defined yet).`;
  return `You classify and summarize a saved web page for a personal bookmark library.
Owner context: software developer. Respond ONLY with JSON matching the schema.
${topicPart}
gist: ONE sentence, max 120 characters, concrete, no fluff.
summary: one paragraph, 3-5 short sentences, what it is and why it might matter.
content_type: one of ${CONTENT_TYPES.join("|")}.
Schema: {"gist": "", "summary": "", "topics": [""], "content_type": ""}`;
}

export async function enrichWithLLM(cfg: Config["llm"], input: EnrichInput): Promise<Enrichment> {
  const userParts = [
    `URL: ${input.url}`,
    input.title ? `Title: ${input.title}` : null,
    input.topicHint ? `Folder hint (from import): ${input.topicHint}` : null,
    input.text ? `Content:\n${input.text.slice(0, MAX_INPUT_CHARS)}` : "Content: (unavailable)",
  ].filter(Boolean);

  const attempt = () =>
    chatJSON(cfg, buildSystemPrompt(input.topicNames), userParts.join("\n\n"));

  let raw: any;
  try {
    raw = await attempt();
  } catch {
    raw = await attempt(); // one retry (design §5), then the caller marks failed
  }
  return validate(raw, input.topicNames);
}

async function chatJSON(cfg: Config["llm"], system: string, user: string): Promise<any> {
  const result = await llmQueue.add(async () => {
    const res = await fetch(`${baseUrlFor(cfg)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  });
  const content = (result as any)?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return JSON.parse(content.replace(/^```(json)?\s*|\s*```$/g, ""));
}

function validate(raw: any, topicNames: string[]): Enrichment {
  if (typeof raw?.gist !== "string" || typeof raw?.summary !== "string") {
    throw new Error("LLM output missing gist/summary");
  }
  const vocab = new Set(topicNames);
  const topics = Array.isArray(raw.topics)
    ? raw.topics.filter((t: unknown): t is string => typeof t === "string" && vocab.has(t))
    : [];
  return {
    gist: raw.gist.slice(0, 200),
    summary: raw.summary,
    content_type: CONTENT_TYPES.includes(raw.content_type) ? raw.content_type : "other",
    topics,
  };
}
