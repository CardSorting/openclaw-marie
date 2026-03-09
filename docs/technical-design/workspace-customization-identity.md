# 🎨 Workspace & Core Identity Strategy

## 🏗️ The Problem: One-Size-Fits-All Agents

Professional engineers need agents that understand their specific domain, project conventions, and team "vibe." A generic agent lacks the necessary guardrails or "architectural instinct" to work in high-stakes codebases.

## 🧠 The Theory: Prompt Layering & Injection

Workspace Customization is based on the theory of **Contextual Identity Layering**. Instead of a monolithic prompt, an agent's "brain" is assembled from multiple, independent markdown files. This allows developers to decouple **Who the Agent is (Soul)** from **What the Project is (Workspace)** and **How to Code (Agents)**.

### Core Principles

1.  **Durable Identity (Soul)**: Defines the agent's persona and behavioral traits (e.g., "The Molty Space Lobster").
2.  **Architectural Guidelines (Agents)**: Injects global technical constraints and project-specific layer rules.
3.  **Command Execution (Tools)**: Provides hints and refined descriptions for how specific tools (like `bash` or `write`) should be used in this workspace.

---

## 🛠️ The Implementation: How it Works

### 1. Workspace Structure & Loading

The `Workspace` manager (`src/agents/workspace.ts`) defines the root directory—typically `~/.openclaw/workspace`. On every agent turn or session initialization, the system scans this directory for key markdown files:

- **`AGENTS.md`**: Global project rules and constraints.
- **`SOUL.md`**: Emotional/behavioral system prompt.
- **`TOOLS.md`**: Overrides or extensions for tool-specific hints.

### 2. Prompt Injection Flow

When an agent session starts, it doesn't just receive its instructions from the Gateway. It "absorbs" its environment:

1.  **System Prompt**: Minimal technical bootstrap.
2.  **`AGENTS.md` Injection**: Injects project-specific architecture rules (e.g., "Always use `pnpm`").
3.  **`SOUL.md` Injection**: Injects the behavioral persona.
4.  **`TOOLS.md` Injection**: Injects specific refinements for the agent's available toolset.

### 3. Skill Integration

Custom **Skills** follow the same pattern. If a `skill/SKILL.md` exists in the workspace, its instructions are injected into the agent's context when that skill is active. This allows for a "Plugin" architecture where an agent can learn new capabilities (e.g., "How to work with Kubernetes") just by reading a file.

### 4. Dynamic Workspace Detection

The system automatically detects if it's running in its "Home" workspace or a target project. If a project has its own `.openclaw/` directory, those files can override the global workspace defaults, allowing for per-project agent specialization.

### 5. Custom Bootstrap Files

Through `hooks/bundled/bootstrap-extra-files`, developers can define arbitrary markdown files that are injected into the agent's context. This is used for temporary project-wide goals or "Sprints" without modifying the core personality files.

---

## 📈 Impact on Development

- **Domain Expertise**: Agents "know" your project's tech stack (e.g., "In this repo, we use HSL for CSS") without being told on every turn.
- **Team Consistency**: Every agent in a team follows the same architectural guidelines injected from a shared `AGENTS.md`.
- **Refined Personality**: Behavioral traits like "conciseness" or "verbosity" are managed centrally, leading to a more professional and predictable experience.
