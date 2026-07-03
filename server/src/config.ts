import { hostname } from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
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
};

// Provider comes from AMBER_LLM_PROVIDER, or is inferred from which standard
// API key env var is set (OPENAI_API_KEY > GEMINI_API_KEY > ollama).
function resolveLlm(): Config["llm"] {
  let provider = process.env.AMBER_LLM_PROVIDER ?? "";
  if (!provider) {
    if (process.env.OPENAI_API_KEY) provider = "openai";
    else if (process.env.GEMINI_API_KEY) provider = "gemini";
    else provider = "ollama";
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
  const dataDir = process.env.AMBER_DATA_DIR ?? path.resolve("data");
  const authToken = process.env.AMBER_TOKEN ?? "";
  if (!authToken) {
    throw new Error("AMBER_TOKEN is required (bearer token for all API access)");
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    dataDir,
    dbPath: path.join(dataDir, "amber.sqlite"),
    authToken,
    llm: resolveLlm(),
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    deviceName: process.env.AMBER_DEVICE ?? hostname(),
  };
}
