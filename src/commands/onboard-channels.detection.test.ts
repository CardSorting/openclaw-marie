import { describe, it, expect } from "vitest";
import { resolveDefaultChannelChoice } from "./onboard-helpers.js";

describe("onboard-helpers", () => {
  describe("resolveDefaultChannelChoice", () => {
    it("should detect telegram if TELEGRAM_BOT_TOKEN is set", () => {
      const env = { TELEGRAM_BOT_TOKEN: "123:ABC" };
      expect(resolveDefaultChannelChoice(env)).toBe("telegram");
    });

    it("should detect slack if SLACK_BOT_TOKEN is set", () => {
      const env = { SLACK_BOT_TOKEN: "xoxb-123" };
      expect(resolveDefaultChannelChoice(env)).toBe("slack");
    });

    it("should detect slack if SLACK_APP_TOKEN is set", () => {
      const env = { SLACK_APP_TOKEN: "xapp-123" };
      expect(resolveDefaultChannelChoice(env)).toBe("slack");
    });

    it("should detect discord if DISCORD_BOT_TOKEN is set", () => {
      const env = { DISCORD_BOT_TOKEN: "token123" };
      expect(resolveDefaultChannelChoice(env)).toBe("discord");
    });

    it("should detect whatsapp if WHATSAPP_ACCOUNT_ID is set", () => {
      const env = { WHATSAPP_ACCOUNT_ID: "123456" };
      expect(resolveDefaultChannelChoice(env)).toBe("whatsapp");
    });

    it("should return undefined if no channel tokens are set", () => {
      const env = {};
      expect(resolveDefaultChannelChoice(env)).toBeUndefined();
    });

    it("should prioritize telegram over slack", () => {
      const env = {
        TELEGRAM_BOT_TOKEN: "123:ABC",
        SLACK_BOT_TOKEN: "xoxb-123",
      };
      expect(resolveDefaultChannelChoice(env)).toBe("telegram");
    });
  });
});
