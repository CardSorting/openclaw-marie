/**
 * Joy-Zoning configuration types.
 *
 * Controls architectural enforcement behavior globally.
 */
export type JoyZoningConfig = {
  /**
   * Enable Joy-Zoning architectural enforcement.
   * Default: true.
   */
  enabled?: boolean;

  /**
   * Enforcement strictness level:
   * - "advisory": Warnings only — never block tool calls.
   * - "enforced": Block Domain violations (first strike), warn others. (Default)
   * - "strict": Block ALL layer violations — maximum enforcement.
   */
  strictness?: "advisory" | "enforced" | "strict";

  /**
   * Persist violation audit trail to SQLite.
   * Default: true.
   */
  persist?: boolean;
};
