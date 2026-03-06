export type PendingToolCall = { id: string; name?: string };

export type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, string | undefined]>;
  getToolName: (id: string) => string | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

import { getStrategicEvolutionStore } from "./strategic-evolution-store.js";

export function createPendingToolCallState(sessionKey?: string): PendingToolCallState {
  const pending = new Map<string, string | undefined>();
  const store = sessionKey ? getStrategicEvolutionStore() : undefined;
  const STATE_KEY = "pending_tool_calls";

  if (sessionKey && store) {
    const persisted = store.getSessionState<Record<string, string | undefined>>(
      sessionKey,
      STATE_KEY,
    );
    if (persisted) {
      for (const [id, name] of Object.entries(persisted)) {
        pending.set(id, name);
      }
    }
  }

  const saveState = () => {
    if (sessionKey && store) {
      store.setSessionState(sessionKey, STATE_KEY, Object.fromEntries(pending));
    }
  };

  return {
    size: () => pending.size,
    entries: () => pending.entries(),
    getToolName: (id: string) => pending.get(id),
    delete: (id: string) => {
      if (pending.delete(id)) {
        saveState();
      }
    },
    clear: () => {
      pending.clear();
      saveState();
    },
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        pending.set(call.id, call.name);
      }
      saveState();
    },
    getPendingIds: () => Array.from(pending.keys()),
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
