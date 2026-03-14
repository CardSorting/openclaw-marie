import { DEFAULT_MODEL, vectorDimsForModel } from "../../extensions/memory-broccolidb/config.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "../commands/auth-choice.api-key.js";
import {
  promptSecretRefForOnboarding,
  resolveSecretInputModeForEnvSelection,
} from "../commands/auth-choice.apply-helpers.js";
import { guardCancel } from "../commands/onboard-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { BroccoliDBConfig } from "../config/types.memory.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

export async function configureMemoryForOnboarding(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  flow: "quickstart" | "advanced";
  secretInputMode?: "plaintext" | "ref";
}): Promise<OpenClawConfig> {
  const { config, prompter, runtime, flow, secretInputMode } = params;

  if (flow === "quickstart") {
    const googleApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleApiKey) {
      return {
        ...config,
        memory: {
          ...config.memory,
          backend: "broccolidb",
          broccolidb: {
            embedding: {
              provider: "google",
              model: DEFAULT_MODEL,
              apiKey: "${GEMINI_API_KEY}",
              dimensions: vectorDimsForModel(DEFAULT_MODEL),
            },
            autoRecall: true,
            autoCapture: true,
          },
        },
      };
    }
    return config;
  }

  const useMemory = guardCancel(
    await prompter.confirm({
      message: "Enable long-term memory (BroccoliDB)?",
      initialValue: config.memory?.backend === "broccolidb",
    }),
    runtime,
  );

  if (!useMemory) {
    if (config.memory?.backend === "broccolidb") {
      return {
        ...config,
        memory: {
          ...config.memory,
          backend: "builtin",
        },
      };
    }
    return config;
  }

  const provider = guardCancel(
    await prompter.select<"google" | "openai">({
      message: "Embedding provider",
      options: [
        { value: "google", label: "Gemini (Google)", hint: "Recommended" },
        { value: "openai", label: "OpenAI-compatible" },
      ],
      initialValue: config.memory?.broccolidb?.embedding.provider ?? "google",
    }),
    runtime,
  );

  let apiKeyText = "";
  let baseUrl: string | undefined = undefined;
  const envVar = provider === "google" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";

  // 1. Check process.env
  const existingEnv =
    process.env[envVar] || (provider === "google" ? process.env.GOOGLE_API_KEY : undefined);

  // 2. Check existing config for agent
  const existingConfigKey = config.models?.providers?.[provider]?.apiKey;

  if (existingEnv) {
    const reuse = guardCancel(
      await prompter.confirm({
        message: `Use ${envVar} from environment?`,
        initialValue: true,
      }),
      runtime,
    );
    if (reuse) {
      apiKeyText = `\${${envVar}}`;
    }
  } else if (existingConfigKey) {
    const reuse = guardCancel(
      await prompter.confirm({
        message: `Reuse ${provider} API key from agent configuration?`,
        initialValue: true,
      }),
      runtime,
    );
    if (reuse) {
      if (typeof existingConfigKey === "string") {
        apiKeyText = existingConfigKey;
      } else if (existingConfigKey.source === "env") {
        apiKeyText = `\${${existingConfigKey.id}}`;
      }
    }
  }

  if (!apiKeyText) {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: secretInputMode,
      copy: {
        plaintextHint: "Save key directly in config (Easiest)",
        refHint: "Reference an environment variable (Advanced)",
      },
    });

    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForOnboarding({
        provider,
        config,
        prompter,
        preferredEnvVar: envVar,
      });
      apiKeyText = `\${${resolved.ref.id}}`;
    } else {
      const key = guardCancel(
        await prompter.text({
          message: `${provider === "google" ? "Gemini" : "OpenAI"} API key`,
          placeholder: provider === "google" ? "AIzaSy..." : "sk-proj-...",
          validate: validateApiKeyInput,
        }),
        runtime,
      );
      apiKeyText = normalizeApiKeyInput(key);
    }
  }

  if (!apiKeyText) {
    await prompter.note(
      "No API key provided for embeddings. BroccoliDB will continue to function but will use keyword-based search only (reduced intelligence).",
      "Memory Fallback",
    );
  }

  if (provider === "openai") {
    const customBaseUrl = guardCancel(
      await prompter.text({
        message: "Endpoint URL (optional)",
        placeholder: "https://api.openai.com/v1",
        initialValue:
          config.memory?.broccolidb?.embedding.baseUrl ?? config.models?.providers?.openai?.baseUrl,
      }),
      runtime,
    );
    if (customBaseUrl?.trim()) {
      baseUrl = customBaseUrl.trim();
    }
  }

  const model = provider === "google" ? DEFAULT_MODEL : "text-embedding-3-small";
  const dimensions = vectorDimsForModel(model);

  const broccolidb: BroccoliDBConfig = {
    embedding: {
      provider,
      model,
      apiKey: apiKeyText,
      dimensions,
      baseUrl,
    },
    autoRecall: true,
    autoCapture: true,
  };

  return {
    ...config,
    memory: {
      ...config.memory,
      backend: "broccolidb",
      broccolidb,
    },
  };
}
