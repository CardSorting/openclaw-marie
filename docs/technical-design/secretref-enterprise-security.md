# 🔐 SecretRef: Enterprise Security Strategy

## 🏗️ The Problem: The "Plaintext Configuration" Gap

Standard configuration files (`openclaw.json`) are often committed to version control systems like Git. If these files contain API keys (e.g., `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) in plaintext, the entire project is compromised once the code is shared. Forcing developers to manually manage environment variables for 60+ potential secrets is complex and error-prone.

## 🧠 The Theory: Indirect Pointer Resolution

SecretRef is based on the theory of **Pointer-Based Secret Injection**. Instead of storing the "Secret Value," the configuration stores a "Secret Reference" (Pointer). The system only resolves the pointer to its corresponding value at the **point of consumption**.

### Core Principles

1.  **Plaintext-Free Configs**: Configuration files are 100% safe to commit to version control.
2.  **Multilateral Resolution**: Secrets can be pulled from varied sources: Environment Variables, System Keychains, or Secure Files.
3.  **Just-In-Time (JIT) Resolution**: Secrets are decrypted and injected into the application's memory only when needed, minimizing the window of exposure.
4.  **Granular Provider Mapping**: Each secret can have its own provider and ID, allowing for complex multi-cloud and multi-tenant security setups.

---

## 🛠️ The Implementation: How it Works

### 1. The `SecretRef` Object

In the configuration, any field that requires a sensitive token can be replaced with a `SecretRef` object:

```json
{
  "api": {
    "key": {
      "source": "env",
      "provider": "openouter",
      "id": "MAIN_KEY"
    }
  }
}
```

### 2. JIT Resolution Logic

When the Gateway or an Agent needs a secret, the `resolveConfiguredSecretInputString` utility (`src/gateway/resolve-configured-secret-input-string.ts`) is called. It:

- **Identifies the Pointer**: Detects if the value is a string or a `SecretRef`.
- **Queries the Backend**: Uses the `secrets/resolve.ts` subsystem to fetch the actual value from the specified source (e.g., `process.env["OPENROUTER_API_KEY"]`).
- **Validates the Payload**: Ensures the resolved secret is a valid, non-empty string.

### 3. Graceful Failure & Diagnostics

If a secret cannot be resolved, the system generates a detailed **UnresolvedRefReason**. This is used by the `openclaw doctor` command to pinpoint exactly which API key is missing or incorrectly mapped, without ever showing the secret itself.

### 4. Cross-Platform Provider Mapping

The `SecretRef` contract (`src/secrets/ref-contract.ts`) supports multiple sources:

- **`env`**: Pulls from environment variables.
- **`file`**: Reads from a secure local sensitive file (mapped via `secrets.defaults.fileBaseDir`).
- **`interactive`**: Prompts the user for input if the secret is missing.
- **`system`**: (Future) Integrates with macOS Keychain or Windows Credential Manager.

### 5. Automated Migration Path

When a user runs `openclaw setup`, the system automatically detects missing keys and offers to create a `SecretRef` mapping for them. This guides non-technical users away from the dangerous path of hardcoding keys.

---

## 📈 Impact on Development

- **Security by Default**: The most dangerous configuration mistake (hardcoding keys) is architecturally prevented.
- **Professional DevOps**: Configurations can be safely managed in Git, and deployments (Docker, VPS) can be configured purely via secure environment injection.
- **Developer Experience**: One command (`openclaw secrets list`) confirms the health of dozens of API keys without exposing them to the screen.
