# 🛡️ JoyZoning: Architectural Integrity Strategy

## 🏗️ The Problem: Architectural Erosion

In fast-paced AI-driven development, "Architectural Erosion" is a constant risk. As agents generate code, they may inadvertently break layer boundaries—for example, by importing UI components into the Domain logic or leaking Infrastructure details into the Core. Over time, this leads to a "Big Ball of Mud" that is difficult to test, maintain, and scale.

## 🧠 The Theory: Automated Policy Enforcement

JoyZoning is based on the theory of **Active Architectural Guardrails**. Instead of relying on passive linting or manual PR reviews, JoyZoning enforces rules at the **point of execution**. It intercepts every file-modifying tool call (`write`, `edit`, `bash`) and validates it against a strict set of topological and content-based rules.

### Core Principles

1.  **Topological Purity**: The codebase is a Directed Acyclic Graph (DAG) of layers: `Domain` → `Core` → `Infrastructure` → `Plumbing` → `UI`. Imports can only flow "downwards" or "inwards."
2.  **Strike-Based Persistence**: Humans (and agents) make mistakes. JoyZoning uses a "Strike" system to differentiate between an accidental mistake (Warning) and a persistent architectural regression (Block).
3.  **Self-Preservation**: The system is designed to be immutable by the agents it governs. Agents are explicitly blocked from modifying the JoyZoning code or policies themselves.

---

## 🛠️ The Implementation: How it Works

### 1. Interception & Evaluation

Whenever an agent calls a file-modifying tool, the `evaluateToolCall` function in `src/agents/joy-zoning.policy.ts` is triggered. It normalizes the file path and identifies the target **Layer**.

### 2. Layer-Specific Strictness

- **Domain (The Heart)**: Zero-tolerance policy. The first strike results in a hard `block`. This ensures the core business logic remains 100% pure and side-effect free.
- **Core / Infrastructure**: Progressive enforcement. The system allows up to 3 warnings (grace attempts) before escalating to a hard `block`. This provides flexibility for iterative development while maintaining a "hard floor" on debt.
- **UI / Plumbing**: Advisory only. These layers are more volatile, so JoyZoning issues warnings but never blocks execution.

### 3. Content "Smell" Detection

JoyZoning doesn't just look at paths; it looks at **intent**.

- **Domain Protections**: Detects forbidden imports like `fs`, `path`, or `express` within the Domain layer.
- **Layer Mismatch**: If an agent tries to write UI code into an Infrastructure file, JoyZoning flags the "Architectural Smell" and suggests the correct layer.

### 4. Graph-Based Cycle Detection

Using a persistent dependency graph stored in SQLite, JoyZoning detects circular dependencies _before_ they are committed to the file system. If `File A` depends on `File B`, and the agent tries to make `File B` depend on `File A`, the operation is blocked with a trace of the cycle.

### 5. Break-Glass Override

For edge cases where the policy is too rigid, developers can include `[JZ:OVERRIDE]` in the agent's thought process. This signals to the policy engine that the deviation is intentional, downgrading any hard blocks to critical warnings.

---

## 📈 Impact on Development

- **Zero Regressions**: Core logic remains isolated and testable.
- **Reduced Review Load**: 90% of architectural "style" issues are caught automatically.
- **Faster Onboarding**: New developers (and agents) are guided by the system to place code in the correct locations from day one.
