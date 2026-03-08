import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSessionIsolationFindings,
} from "./audit-extra.sync.js";
import { safeEqualSecret } from "./secret-equal.js";

describe("collectAttackSurfaceSummaryFindings", () => {
  it("distinguishes external webhooks from internal hooks when only internal hooks are enabled", () => {
    const cfg: OpenClawConfig = {
      hooks: { internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.checkId).toBe("summary.attack_surface");
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as enabled when both are configured", () => {
    const cfg: OpenClawConfig = {
      hooks: { enabled: true, internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: enabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as disabled when neither is configured", () => {
    const cfg: OpenClawConfig = {};

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: disabled");
  });
});

describe("safeEqualSecret", () => {
  it("matches identical secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-token")).toBe(true);
  });

  it("rejects mismatched secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects different-length secrets", () => {
    expect(safeEqualSecret("short", "much-longer")).toBe(false);
  });

  it("rejects missing values", () => {
    expect(safeEqualSecret(undefined, "secret")).toBe(false);
    expect(safeEqualSecret("secret", undefined)).toBe(false);
    expect(safeEqualSecret(null, "secret")).toBe(false);
  });
});

describe("collectSessionIsolationFindings", () => {
  it("reports no findings for safe configuration", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        whatsapp: { accounts: { main: {} } },
      },
    };

    const findings = collectSessionIsolationFindings(cfg);
    expect(findings).toHaveLength(0);
  });

  it("flags high-risk agents using 'main' scope", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      agents: {
        list: [
          {
            id: "risky-agent",
            tools: { allow: ["exec"] },
          },
        ],
      },
    };

    const findings = collectSessionIsolationFindings(cfg);
    const riskFinding = findings.find(
      (f) => f.checkId === "session.isolation.risky_tools_broad_scope",
    );
    expect(riskFinding).toBeDefined();
    expect(riskFinding?.detail).toContain("sensitive tools (exec/process/fs)");
  });

  it("flags multi-account channels without account-level isolation", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        whatsapp: {
          accounts: {
            personal: {},
            work: {},
          },
        },
      },
    };

    const findings = collectSessionIsolationFindings(cfg);
    const multiAccountFinding = findings.find(
      (f) => f.checkId === "session.isolation.multi_account_leakage",
    );
    expect(multiAccountFinding).toBeDefined();
    expect(multiAccountFinding?.detail).toContain('Channel "whatsapp" has multiple accounts');
    expect(multiAccountFinding?.remediation).toContain("per-account-channel-peer");
  });
});
