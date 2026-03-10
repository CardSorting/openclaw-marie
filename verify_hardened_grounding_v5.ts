import { IntentGrounder } from "./src/agents/grounding/IntentGrounder.js";
import { loadConfig } from "./src/config/config.js";

async function run() {
  const cfg = loadConfig();
  const grounder = new IntentGrounder(cfg);

  // Test Case: Pass 5 Features (Similarity and Latency Breakdown)
  const intent = "Add a new endpoint to the gateway that clears the session cache.";
  console.log("--- Pass 5: Final Production Audit Test ---");
  const spec = await grounder.ground(intent, {
    workspaceDir: process.cwd(),
    agentId: "marie",
    sessionKey: "test-session-pass5",
  });

  console.log("Grounded Intent:", spec.intent);
  console.log("Rules Identified:", spec.rules);
  console.log("Confidence:", spec.confidence);
  console.log("Metadata (Final Audit):", {
    latency: spec.metadata.latencyMs,
    breakdown: spec.metadata.latencyBreakdown,
    similarity: spec.metadata.similarity,
    drift: spec.metadata.drift,
  });

  if (spec.metadata.error) {
    console.error("Grounding Error (Fallback):", spec.metadata.error);
  }

  console.log("\n--- Verification Complete ---");
}

run().catch(console.error);
