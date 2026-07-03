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
    llm: {
      provider: process.env.AMBER_LLM_PROVIDER ?? "openai",
      apiKey: process.env.AMBER_LLM_API_KEY ?? "",
      model: process.env.AMBER_LLM_MODEL ?? "gpt-4o-mini",
      baseUrl: process.env.AMBER_LLM_BASE_URL,
    },
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    deviceName: process.env.AMBER_DEVICE ?? hostname(),
  };
}
