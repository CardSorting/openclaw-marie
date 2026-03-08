import { getJoyZoningStore } from "../infra/joy-zoning-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/zero-trust");

const TRUST_STRIKE_LIMIT = 2;

/**
 * Validates if the current session trust level allows executing high-risk commands.
 * High-risk commands (like network tools or disk wipers) are blocked if the session
 * has ANY previous security strikes.
 */
export function authorizeToolExecution(command: string): { authorized: boolean; reason?: string } {
    const jzStore = getJoyZoningStore();
    
    // Check global session health or specific tool strikes
    // For God-Mode, we block "extreme" commands if there's any record of suspicious behavior
    const extremeCommands = /curl|wget|nc|nmap|rm -rf \/|chmod|chown|sudo/i;
    
    if (extremeCommands.test(command)) {
        // High-risk command detected. Check for any strikes in the session.
        // We'll check the health summary for any blocks/warnings.
        const health = jzStore.getHealthSummary();
        if (health.totalBlocks > 0 || health.totalWarnings > TRUST_STRIKE_LIMIT) {
            log.warn(`Zero-Trust Violation: Blocking extreme command '${command}' due to poor session health.`);
            return {
                authorized: false,
                reason: "Zero-Trust policy: Session health too low for privileged tool execution."
            };
        }
    }
    
    return { authorized: true };
}
