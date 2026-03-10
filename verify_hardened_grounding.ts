import { IntentGrounder } from "./src/agents/grounding/IntentGrounder.js";
import { loadConfig } from "./src/config/config.js";

async function run() {
  const cfg = loadConfig();
  const grounder = new IntentGrounder(cfg);

  const intent =
    "I need to add a new route to the Next.js app for user profiles and make sure it follows the project's styling rules.";

  console.log("--- Pass 1: Initial Grounding ---");
  const spec = await grounder.ground(intent, {
    workspaceDir: process.cwd(),
    agentId: "marie",
    sessionKey: "test-session",
  });

  console.log("Grounded Intent:", spec.intent);
  console.log("Rules:", spec.rules);
  console.log("Markers:", spec.environmentMarkers);
  console.log("Confidence:", spec.confidence);
  console.log("Metadata:", spec.metadata);

  console.log("\n--- Pass 2: Subagent Inheritance ---");
  const subagentIntent = "Create the profile page component.";
  const subSpec = await grounder.ground(
    subagentIntent,
    {
      workspaceDir: process.cwd(),
      agentId: "marie",
      sessionKey: "sub-session",
    },
    spec,
  );

  console.log("Subagent Grounded Intent:", subSpec.intent);
  console.log("Subagent Inherited/New Rules:", subSpec.rules);
  console.log("Subagent Metadata:", subSpec.metadata);
}

run().catch(console.error);
