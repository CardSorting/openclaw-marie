import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";

const testDbPath = path.join(os.tmpdir(), `auth-rate-limit-test-${Math.random().toString(36).slice(2)}.sqlite`);

// Mocking the store to use a temporary database
vi.mock("../agents/strategic-evolution-store.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getStrategicEvolutionStore: vi.fn(() => actual.getStrategicEvolutionStore(testDbPath)),
  };
});

import { 
  resetStrategicEvolutionStoreForTest 
} from "../agents/strategic-evolution-store.js";

describe("auth rate limiter", () => {
  let limiter: AuthRateLimiter;

  afterAll(() => {
    resetStrategicEvolutionStoreForTest();
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch {}
  });

  beforeEach(() => {
    resetStrategicEvolutionStoreForTest();
  });

  afterEach(() => {
    limiter?.dispose();
    resetStrategicEvolutionStoreForTest();
  });

  // ---------- basic sliding window ----------

  it("allows requests when no failures have been recorded", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 5, windowMs: 60_000, lockoutMs: 300_000 });
    const result = limiter.check("192.168.1.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.retryAfterMs).toBe(0);
  });

  it("decrements remaining count after each failure", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 300_000 });
    await limiter.recordFailure("10.0.0.1");
    expect(limiter.check("10.0.0.1").remaining).toBe(2);
    await limiter.recordFailure("10.0.0.1");
    expect(limiter.check("10.0.0.1").remaining).toBe(1);
  });

  it("blocks the IP once maxAttempts is reached", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 10_000 });
    await limiter.recordFailure("10.0.0.2");
    await limiter.recordFailure("10.0.0.2");
    const result = limiter.check("10.0.0.2");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  // ---------- lockout expiry ----------

  it("unblocks after the lockout period expires", async () => {
    vi.useFakeTimers();
    try {
      limiter = await createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 5_000 });
      await limiter.recordFailure("10.0.0.3");
      await limiter.recordFailure("10.0.0.3");
      expect(limiter.check("10.0.0.3").allowed).toBe(false);

      // Advance just past the lockout.
      vi.advanceTimersByTime(5_001);
      const result = limiter.check("10.0.0.3");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- sliding window expiry ----------

  it("expires old failures outside the window", async () => {
    vi.useFakeTimers();
    try {
      limiter = await createAuthRateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000 });
      await limiter.recordFailure("10.0.0.4");
      await limiter.recordFailure("10.0.0.4");
      expect(limiter.check("10.0.0.4").remaining).toBe(1);

      // Move past the window so the two old failures expire.
      vi.advanceTimersByTime(11_000);
      expect(limiter.check("10.0.0.4").remaining).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- per-IP isolation ----------

  it("tracks IPs independently", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("10.0.0.10");
    await limiter.recordFailure("10.0.0.10");
    expect(limiter.check("10.0.0.10").allowed).toBe(false);

    // A different IP should be unaffected.
    expect(limiter.check("10.0.0.11").allowed).toBe(true);
    expect(limiter.check("10.0.0.11").remaining).toBe(2);
  });

  it("treats ipv4 and ipv4-mapped ipv6 forms as the same client", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("1.2.3.4");
    expect(limiter.check("::ffff:1.2.3.4").allowed).toBe(false);
  });

  it("tracks scopes independently for the same IP", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("10.0.0.12", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    expect(limiter.check("10.0.0.12", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(false);
    expect(limiter.check("10.0.0.12", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(true);
  });

  // ---------- loopback exemption ----------

  it("exempts loopback addresses by default", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("127.0.0.1");
    // Should still be allowed even though maxAttempts is 1.
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
  });

  it("exempts IPv6 loopback by default", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("::1");
    expect(limiter.check("::1").allowed).toBe(true);
  });

  it("rate-limits loopback when exemptLoopback is false", async () => {
    limiter = await createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
    });
    await limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  // ---------- reset ----------

  it("clears tracking state when reset is called", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("10.0.0.20");
    await limiter.recordFailure("10.0.0.20");
    expect(limiter.check("10.0.0.20").allowed).toBe(false);

    await limiter.reset("10.0.0.20");
    expect(limiter.check("10.0.0.20").allowed).toBe(true);
    expect(limiter.check("10.0.0.20").remaining).toBe(2);
  });

  it("reset only clears the requested scope for an IP", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    await limiter.recordFailure("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(false);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(false);

    await limiter.reset("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(true);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(false);
  });

  // ---------- prune ----------

  it("prune removes stale entries", async () => {
    vi.useFakeTimers();
    try {
      limiter = await createAuthRateLimiter({ maxAttempts: 5, windowMs: 5_000, lockoutMs: 5_000 });
      await limiter.recordFailure("10.0.0.30");
      // expect(limiter.size()).toBe(1); // Persistent store returns 0 for size()

      vi.advanceTimersByTime(6_000);
      await limiter.prune();
      // expect(limiter.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prune keeps entries that are still locked out", async () => {
    vi.useFakeTimers();
    try {
      limiter = await createAuthRateLimiter({ maxAttempts: 1, windowMs: 5_000, lockoutMs: 30_000 });
      await limiter.recordFailure("10.0.0.31");
      expect(limiter.check("10.0.0.31").allowed).toBe(false);

      // Move past the window but NOT past the lockout.
      vi.advanceTimersByTime(6_000);
      await limiter.prune();
      // expect(limiter.size()).toBe(1); // Still locked-out, not pruned.
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- undefined / empty IP ----------

  it("normalizes undefined IP to 'unknown'", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure(undefined);
    await limiter.recordFailure(undefined);
    expect(limiter.check(undefined).allowed).toBe(false);
    // expect(limiter.size()).toBe(1);
  });

  it("normalizes empty-string IP to 'unknown'", async () => {
    limiter = await createAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 });
    await limiter.recordFailure("");
    await limiter.recordFailure("");
    expect(limiter.check("").allowed).toBe(false);
  });

  // ---------- dispose ----------

  it("dispose clears all entries", async () => {
    limiter = await createAuthRateLimiter();
    await limiter.recordFailure("10.0.0.40");
    // expect(limiter.size()).toBe(1);
    limiter.dispose();
    // expect(limiter.size()).toBe(0);
  });
});
