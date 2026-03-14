import { Cron } from "croner";
import { loadSessionStore, updateSessionStore } from "../config/sessions.js";
import type { CronServiceState } from "./service/state.js";

/** Minimum interval between autonomy nudges per store. */
const MIN_NUDGE_INTERVAL_MS = 60_000; // 1 minute

const lastNudgeAtMsByStore = new Map<string, number>();

/**
 * Resolves the nudge message based on the nudge count and intensity.
 */
function resolveNudgeText(params: { nudgeCount: number; token?: string }): string {
  const { nudgeCount, token } = params;
  const continuation = token ? ` (Continuation token: ${token})` : "";

  if (nudgeCount <= 1) {
    return `Continue with your task.${continuation}`;
  }
  if (nudgeCount === 2) {
    return `Progress check: Are you still working on your autonomous task?${continuation}`;
  }
  if (nudgeCount === 3) {
    return `Task appears stalled. Please provide a status update or continue.${continuation}`;
  }
  return `CRITICAL: Autonomous task has been idle through ${nudgeCount} nudges. Resuming now.${continuation}`;
}

/**
 * Sweep active ACP sessions in a specific store and nudge those that appear
 * to be stalled autonomous tasks.
 */
export async function sweepAutonomyNudges(params: {
  state: CronServiceState;
  sessionStorePath: string;
}): Promise<void> {
  const { state, sessionStorePath } = params;
  const now = state.deps.nowMs();
  const lastNudgeAtMs = lastNudgeAtMsByStore.get(sessionStorePath) ?? 0;

  // Throttle: don't nudge more often than every 1 minute per store.
  if (now - lastNudgeAtMs < MIN_NUDGE_INTERVAL_MS) {
    return;
  }

  const config = state.deps.cronConfig?.autonomyNudge;
  if (config?.enabled === false) {
    lastNudgeAtMsByStore.set(sessionStorePath, now);
    return;
  }

  const globalIdleMinutes = config?.idleMinutes ?? 5;
  const globalIdleThresholdMs = globalIdleMinutes * 60_000;

  try {
    const store = loadSessionStore(sessionStorePath);
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (entry?.acp?.state !== "idle") {
        continue;
      }

      const acp = entry.acp;
      const lastActivity = acp.lastActivityAt || entry.updatedAt || 0;

      // Priority 1: Explicitly scheduled next nudge
      // Priority 2: Periodic cron schedule
      // Priority 3: Session-specific nudge interval
      // Priority 4: Global nudge interval
      let shouldNudge = false;
      if (acp.nextNudgeAt && acp.nextNudgeAt > 0) {
        if (now >= acp.nextNudgeAt) {
          shouldNudge = true;
        }
      } else if (acp.nudgeSchedule) {
        try {
          const cron = new Cron(acp.nudgeSchedule, { timezone: "UTC" });
          const lastNudge = acp.lastNudgeAt || lastActivity;
          const nextExpected = cron.nextRun(new Date(lastNudge));
          if (nextExpected && now >= nextExpected.getTime()) {
            shouldNudge = true;
          }
        } catch (err) {
          state.deps.log.warn(
            { err: String(err), sessionKey, schedule: acp.nudgeSchedule },
            "cron: invalid nudgeSchedule",
          );
        }
      } else {
        const sessionIntervalMs = acp.runtimeOptions?.nudgeIntervalMs;
        const thresholdMs =
          sessionIntervalMs && sessionIntervalMs > 0 ? sessionIntervalMs : globalIdleThresholdMs;

        if (now - lastActivity >= thresholdMs) {
          shouldNudge = true;
        }
      }

      if (!shouldNudge) {
        continue;
      }

      // Priority 1: Explicitly signaled autonomous task
      // Priority 2: Heuristic-based task (legacy/fallback)
      const isExplicitTask = acp.isAutonomous === true;
      const label = entry.label?.toLowerCase() || "";
      const key = sessionKey.toLowerCase();
      const isHeuristicTask =
        label.includes("task") ||
        key.includes("task") ||
        label.includes("autonomy") ||
        key.includes("autonomy") ||
        label.includes("autonomous");

      if (!isExplicitTask && !isHeuristicTask) {
        continue;
      }

      const nudgeCount = (acp.nudgeCount ?? 0) + 1;
      const nudgeText = resolveNudgeText({
        nudgeCount,
        token: acp.taskContinuationToken,
      });

      state.deps.log.info(
        {
          sessionKey,
          idleMs: now - lastActivity,
          explicit: isExplicitTask,
          nudgeCount,
          hasToken: !!acp.taskContinuationToken,
        },
        "cron: nudging idle autonomy task",
      );

      state.deps.enqueueSystemEvent(nudgeText, {
        sessionKey,
        contextKey: "cron:autonomy-nudge",
      });
      state.deps.requestHeartbeatNow({
        reason: "cron:autonomy-nudge",
        sessionKey,
      });

      // Update session state to track nudges and avoid immediate re-nudge.
      await updateSessionStore(sessionStorePath, (innerStore) => {
        const target = innerStore[sessionKey];
        if (target?.acp) {
          target.acp.lastActivityAt = now;
          target.acp.lastNudgeAt = now;
          target.acp.nudgeCount = nudgeCount;
          // Clear explicit schedule once fired
          delete target.acp.nextNudgeAt;
        }
      });
    }
  } catch (err) {
    state.deps.log.warn(
      { err: String(err), sessionStorePath },
      "cron: autonomy-nudge sweep failed",
    );
  }

  lastNudgeAtMsByStore.set(sessionStorePath, now);
}

/** Reset the throttle timer (for tests). */
export function resetAutonomyNudgeThrottle(): void {
  lastNudgeAtMsByStore.clear();
}
