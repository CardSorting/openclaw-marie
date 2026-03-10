import { IntentGrounder } from "./src/agents/grounding/IntentGrounder.js";

async function run() {
  const cfg: Record<string, unknown> = {}; // Replaced loadConfig() with an empty mock config
  const grounder = new IntentGrounder(cfg);

  const intent =
    "Modify the gateway to ignore calls from blocked users. Ensure it follows the JoyZoning pillars mentioned in README.";

  console.log("--- Pass 3: Hardened Grounding with Rule Ingestion ---");
  const spec = await grounder.ground(intent, {
    workspaceDir: process.cwd(),
    agentId: "marie",
    sessionKey: "test-session-pass3",
  });

  console.log("Grounded Intent:", spec.intent);
  console.log("Rules Identified:", spec.rules);
  console.log("Confidence:", spec.confidence);
  console.log("Metadata (Drift/Retry):", {
    drift: spec.metadata.drift,
    retryCount: spec.metadata.retryCount,
    latency: spec.metadata.latencyMs,
  });

  if (spec.metadata.error) {
    console.error("Grounding Error:", spec.metadata.error);
  }

  console.log("\n--- Verification Complete ---");
}

run().catch(console.error);
