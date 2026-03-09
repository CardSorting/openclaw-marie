# Joy-Zoning: Architectural Integrity for Autonomous Agents

## Overview

**Joy-Zoning** is a first-class feature in OpenClaw designed to solve a fundamental problem with autonomous AI coding agents: their tendency to unintentionally violate or erode deeply held architectural boundaries.

When agents are given free rein over a codebase, they often choose the path of least resistance. This can lead to frontend code mutating backend schemas, or infrastructure layers illegally importing UI components. Joy-Zoning acts as an autonomous "zoning commission," actively detecting, preventing, and correcting cross-layer contamination during the agent's tool loop _before_ bad code gets committed.

## The Value Add

### 1. Zero-Erosion Agentic Coding

Typical agents slowly degrade the structural integrity of a project over time. Joy-Zoning allows you to confidently deploy OpenClaw agents on long-running maintenance or feature tasks without fear that they will create architectural "spaghetti." The codebase remains as pristine and separated as a human architect intended.

### 2. Live Diagnostic "Strikes" and Corrective Backpressure

Joy-Zoning doesn't just block actions—it gives agents **strikes** when they attempt unauthorized imports or mutations across forbidden layer boundaries (e.g., Domain -> Infrastructure).
These strikes are more than just logs; they exert _backpressure_ directly into the agent's context window. If an agent tries to hack around a boundary, the strike warns it, and it will autonomously course-correct its implementation plan to respect the architecture.

### 3. Hyper-Relevant Context Enrichment

Joy-Zoning tracks its state dynamically. Instead of relying on a static "DO NOT DO THIS" prompt that an LLM might ignore, Joy-Zoning enriches the environment:

- **Prepended Read Context**: When an agent uses the `read` tool to look at a file, Joy-Zoning automatically prepends the file's architectural layer to the output (`[Joy-Zoning Context: INFRASTRUCTURE LAYER]`). The agent knows exactly where it is working before it even plans an edit.
- **Session-Aware Injections**: The agent's `system-prompt` is dynamically updated with the active "strike list" for the specific files it is mutating in its current session. This hyper-local context effectively trains the agent on the fly.

### 4. Self-Healing Exits

Joy-Zoning isn't just punitive. By actively hooking into the tool execution lifecycle, it automatically clears strikes from a file the moment an agent successfully refactors it to comply with the zoning policy. This creates a natural, rewarding feedback loop for the LLM.

### 5. Configurable Strictness

It ships with configurable enforcement modes (`advisory`, `standard`, `strict`). You can slowly introduce Joy-Zoning to legacy projects in `advisory` mode (getting logs and metrics without blocking the agent), and later escalate to `strict` mode to mandate absolute compliance on hardened greenfield projects.

## How it Works Under the Hood

1. **Layer Detection**: Resolves any file path into an architectural layer based on internal heuristics or configuration definitions.
2. **Policy Checking**: Evaluates every `write`, `edit`, and `patch` tool call against a predefined matrix of allowed cross-layer mutations.
3. **Audit Store**: Persists violations to a rotating SQLite database (`~/.openclaw/joy-zoning/audit.sqlite`), allowing human architects to run `openclaw joy-zoning health` later and audit exactly where the agent struggled to maintain the architecture.
4. **Lifecycle Hooks**: Triggers native events on every violation, allowing real-time CLI diagnostic streams and cron-based database pruning.

## Summary

By integrating Joy-Zoning, OpenClaw transforms from a simple autonomous code-generator into an **Architecturally-Aware Maintainer**. It actively defends your project's structural patterns, extending the lifespan of the codebase while maximizing autonomous productivity.
