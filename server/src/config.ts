import { hostname } from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  databaseUrl: string;
  authToken: string;
  llm: {
    provider: string; // openai|gemini|ollama
    apiKey: string;
    model: string;
    baseUrl?: string;
  };
  geminiApiKey: string; // required for YouTube branch
  deviceName: string;
}

const PROVIDER_DEFAULTS: Record<string, { keyVar: string; model: string }> = {
  openai: { keyVar: "OPENAI_API_KEY", model: "gpt-4o-mini" },
  gemini: { keyVar: "GEMINI_API_KEY", model: "gemini-2.0-flash" },
  ollama: { keyVar: "", model: "llama3.1" },
  none: { keyVar: "", model: "" },
};

// Provider comes from AMBER_LLM_PROVIDER, or is inferred from which standard
// API key env var is set (OPENAI_API_KEY > GEMINI_API_KEY > ollama).
function resolveLlm(): Config["llm"] {
  let provider = process.env.AMBER_LLM_PROVIDER ?? "";
  if (!provider) {
    if (process.env.OPENAI_API_KEY) provider = "openai";
    else if (process.env.GEMINI_API_KEY) provider = "gemini";
    else if (process.env.AMBER_LLM_BASE_URL) provider = "ollama";
    else provider = "none"; // metadata-only: fetch/extract run, no gist/summary
  }
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;
  return {
    provider,
    apiKey: defaults.keyVar ? (process.env[defaults.keyVar] ?? "") : "ollama",
    model: process.env.AMBER_LLM_MODEL ?? defaults.model,
    baseUrl: process.env.AMBER_LLM_BASE_URL,
  };
}

export function loadConfig(): Config {
  // Archives, cached assets, backups, and trash live on disk regardless of the
  // metadata database; DATA_DIR is the Dokku-provisioned mount, AMBER_DATA_DIR
  // the local override.
  const dataDir = process.env.AMBER_DATA_DIR ?? process.env.DATA_DIR ?? path.resolve("data");
  const authToken = process.env.AMBER_TOKEN ?? "";
  if (!authToken) {
    throw new Error("AMBER_TOKEN is required (bearer token for all API access)");
  }
  const databaseUrl = process.env.DATABASE_URL ?? process.env.AMBER_DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (Postgres connection string)");
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    dataDir,
    databaseUrl,
    authToken,
    llm: resolveLlm(),
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    deviceName: process.env.AMBER_DEVICE ?? hostname(),
  };
}
