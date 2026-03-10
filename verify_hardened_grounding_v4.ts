import { IntentGrounder } from "./src/agents/grounding/IntentGrounder.js";
import { loadConfig } from "./src/config/config.js";

async function run() {
  const cfg = loadConfig();
  const grounder = new IntentGrounder(cfg);

  // Test Case 1: Contextual Filtering (intent with specific keywords)
  const intent1 = "Implement a new Slack channel using the provider-web extension.";
  console.log("--- Pass 4: Contextual Filtering Test ---");
  const spec1 = await grounder.ground(intent1, {
    workspaceDir: process.cwd(),
    agentId: "marie",
    sessionKey: "test-session-pass4-filter",
  });
  console.log("Grounded Intent:", spec1.intent);
  console.log("Metadata (Latency):", spec1.metadata.latencyMs);

  // Test Case 2: Missing Info (simulated by low info intent - this might not trigger prompt in script but check spec)
  const intent2 = "Fix the bug in the controller.";
  console.log("\n--- Pass 4: Missing Info Detection ---");
  const spec2 = await grounder.ground(intent2, {
    workspaceDir: process.cwd(),
    agentId: "marie",
    sessionKey: "test-session-pass4-missing",
  });
  console.log("Missing Info:", spec2.missingInfo);
  console.log("Confidence:", spec2.confidence);

  console.log("\n--- Verification Complete ---");
}

run().catch(console.error);
