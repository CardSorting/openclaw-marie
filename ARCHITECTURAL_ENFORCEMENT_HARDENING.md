# Architectural Enforcement: From Crash to Correction

This document summarizes the changes made to the Codemarie architectural policy engine to resolve agent crashing on strikes and implement production-grade hardening.

## 1. The "Fix-It" Flow: Progressive Enforcement

Previously, architectural violations caused an immediate "PRE-FLIGHT ARCHITECTURAL REJECTION," which led to agent crashes and deadlocks. The system has been evolved into a progressive enforcement model:

- **Strike 1 (Domain Only)**: If a critical violation occurs in a Domain file for the first time, the write is blocked with an `🏗️ ARCHITECTURAL CORRECTION REQUIRED` message. This uses the `error_retry` signal to guide the agent to repair and resubmit.
- **Strike 2+ / Other Layers**: To prevent infinite deadlocks, subsequent violations (or violations in non-Domain layers) are degraded to `⚠️ ARCHITECTURAL WARNING` messages. The write is allowed, but the agent is instructed to fix the debt in a follow-up.
- **`any` Type Relaxation**: The "heavy typing restriction" was removed. The `any` type is now reported as a non-blocking `⚠️ DISCERNMENT WARNING` architectural smell.

## 2. Production Hardening Measures

### Persistent Strike Tracking
Strikes are no longer stored in ephemeral memory. They are persisted in the global state via `StateManager`:
- **Persistence**: Strikes for each file are saved in `architecturalStrikes` within the global state.
- **Stability**: The policy engine remembers previous violations even after an application restart, ensuring the "Strike 1 block" remains consistent.

### AST-Based Deep Audits
Fragile regex-based checks for layering and platform leakage have been replaced with deep TypeScript AST analysis:
- **TspPolicyPlugin**: The core transformer now performs comprehensive layering audits at the AST level.
- **Alias Resolution**: The engine now handles project path aliases (`@/`, `@core/`, `@shared/`, etc.) by resolving them against the `tsconfig.json` structure before validation.
- **Node.js Restriction**: Expanded the list of restricted Node.js modules for the Domain layer (e.g., `fs`, `path`, `crypto`, `http`, `net`).

### Stability & Entropy Monitoring
A new monitoring layer was added to `FluidPolicyEngine`:
- **Entropy Detection**: The engine validates that tool outputs match expected hashes (`prevResultHash`).
- **Divergence Warning**: If output diverges significantly from expectations, an `⚠️ ENTROPY WARNING` is issued to alert the agent to potential structural instability.

## 3. Core Component Updates

- **`FluidPolicyEngine.ts`**: Orchestrates persistence, strike logic, and AST-based audits.
- **`TspPolicyPlugin.ts`**: Implements the deep TypeScript AST validation and alias resolution.
- **`UniversalGuard.ts`**: Unified entry point for all enforcement, now wired with `StateManager`.
- **`ToolExecutor.ts`**: Integrated with `error_retry` logic to handle architectural corrections gracefully.
- **`responses.ts`**: Added specific `architecturalCorrection` response formats for clear agent guidance.

---
*Last Updated: 2026-03-06*
