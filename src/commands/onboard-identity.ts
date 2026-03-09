import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export async function promptAssistantIdentity(
  config: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const existingName = config.ui?.assistant?.name ?? "Marie";
  const existingAvatar = config.ui?.assistant?.avatar ?? "🤖";

  const nextName = await prompter.text({
    message: "Assistant display name",
    initialValue: existingName,
    placeholder: "e.g. Marie, Jarvis, Hal 9000",
  });

  const nextAvatar = await prompter.text({
    message: "Assistant avatar (emoji, text, or image URL)",
    initialValue: existingAvatar,
    placeholder: "e.g. 🤖, 🦁, https://example.com/avatar.png",
  });

  return {
    ...config,
    ui: {
      ...config.ui,
      assistant: {
        ...config.ui?.assistant,
        name: String(nextName ?? existingName).trim() || existingName,
        avatar: String(nextAvatar ?? existingAvatar).trim() || existingAvatar,
      },
    },
  };
}
