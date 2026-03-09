import { describe, it, expect, beforeEach } from "vitest";
import { SessionHistorySearch } from "./session-history-search.js";

describe("session-history-search", () => {
  let historySearch: SessionHistorySearch;

  beforeEach(() => {
    historySearch = new SessionHistorySearch();
  });

  it("indexes a session without error", async () => {
    await expect(
      historySearch.indexSession("session-1", [{ role: "user", content: "hello" }]),
    ).resolves.toBeUndefined();
  });

  it("searches history and returns results (placeholder)", async () => {
    const results = await historySearch.searchHistory("test query");
    expect(Array.isArray(results)).toBe(true);
  });

  it("snapshots session summary without error", async () => {
    await expect(
      historySearch.snapshotSessionSummary("session-1", "A good session."),
    ).resolves.toBeUndefined();
  });
});
