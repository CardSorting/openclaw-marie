import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_CATEGORIES,
  type BroccoliDBConfig,
  type MemoryCategory,
} from "openclaw/plugin-sdk/memory-broccolidb";

export const DEFAULT_MODEL = "gemini-embedding-2-preview";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;

function resolveDefaultDbPath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "memory", "broccolidb");
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // best-effort
  }
  return preferred;
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "gemini-embedding-2-preview": 768,
  "text-embedding-004": 768,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export const broccolidbConfigSchema = {
  parse(value: unknown): BroccoliDBConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("broccolidb config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dbPath", "autoCapture", "autoRecall", "captureMaxChars"],
      "broccolidb config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "baseUrl", "dimensions"], "embedding config");

    const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;

    return {
      embedding: {
        provider: (cfg.embedding as any).provider === "google" ? "google" : "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : undefined,
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "API Key",
      sensitive: true,
      placeholder: "sk-proj-... or AIzaSy...",
      help: "API key for embeddings (OpenAI or Gemini)",
    },
    "embedding.baseUrl": {
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
      help: "Base URL for compatible providers (e.g. http://localhost:11434/v1)",
      advanced: true,
    },
    "embedding.dimensions": {
      label: "Dimensions",
      placeholder: "1536",
      help: "Vector dimensions for custom models",
      advanced: true,
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model to use (OpenAI or Gemini)",
    },
    dbPath: {
      label: "Database Path",
      placeholder: "~/.openclaw/memory/broccolidb",
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    captureMaxChars: {
      label: "Capture Max Chars",
      help: "Maximum message length eligible for auto-capture",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
  },
};
