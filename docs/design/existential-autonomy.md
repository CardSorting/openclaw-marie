# Existential Autonomy Strategy

## Overview

**Existential Autonomy** is the architectural state where MarieCoder operates as a self-regulating, zero-touch engineering substrate. It moves beyond simple task execution into **Systemic Governance**, where the agent is responsible for its own resource management, error correction, and architectural integrity without human intervention.

## Core Mechanisms

### 1. Systemic Governance & Load Balancing

Marie does not blindly spawn subagents. The system monitors the host environment's physical health in real-time.

- **Load Monitor**: Integrates with `node:os` to track CPU load averages and memory pressure.
- **Throttling**: If systemic load exceeds 85%, the `FluidPolicyEngine` autonomously defers non-critical subagent spawning.
- **Maintenance Decoupling**: Background tasks like memory compaction are throttled or deferred during high-intensity remediation cycles.

### 2. Critique-Driven Remediation (Lessons Learned)

Instead of escalating to more expensive or higher-reasoning models upon failure, Marie implements a **Critique-Loop**.

- **Critique Snapshots**: When a remediation fails (e.g., build breakage), the system captures a "Critique" containing the failed diff, the error output, and an autonomous post-mortem.
- **Learning Injection**: These critiques are injected into the next remediation attempt as "Lessons Learned." This allows the system to converge on a solution by learning from its own entropy drift.

### 3. Systemic Health Steering

The system maintains a **Global Health Score** (0.0 - 1.0) derived from:

- **Success Rate**: Recent remediation/task completion ratio.
- **Latency Consistency**: Stability of tool execution times.

**Adaptive Guardrails**:

- **High Health**: Guardrails are permissive, allowing for rapid iteration.
- **Low Health**: The system autonomously tightens `JoyZoning` restrictions and triggers a "Sync & Audit" pass to reconcile the codebase before proceeding.

### 4. Autonomous Rollbacks

Stability is guaranteed by a "Last Known Good" (LKG) protocol.

- **Persistent State**: All session data and file snapshots are stored in a systemic SQLite database (`StrategicEvolutionStore`).
- **Zero-Touch Reversion**: If a remediation fails to resolve a block-level violation or breaks the build, Marie autonomously reverts the affected files to their LKG snapshot before reporting back.

### 5. Systemic Architect Subagents

In scenarios involving architectural deadlocks or complex "Choke Points," the system spawns specialized **Architect Subagents**.

- **Scope**: These agents have full authority to refactor cross-module dependencies.
- **Trigger**: Spawned only when standard remediation fails to resolve drift after multiple critique-driven attempts.

---

## Technical Implementation Reference

- `src/agents/strategic-evolution-store.ts`: The persistent backbone for metrics and state.
- `src/agents/evolutionary-pilot.ts`: The orchestrator for health steering and remediation verification.
- `src/agents/FluidPolicyEngine.ts`: The enforcement engine for load-balanced governance.
- `src/agents/marie-memory-compactor.ts`: Autonomous context management.
