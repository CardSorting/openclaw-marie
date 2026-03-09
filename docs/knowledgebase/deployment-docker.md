# 🐳 Ready-to-Deploy Docker (Containerized)

For users who want an isolated, enterprise-grade deployment, MarieCoder is fully containerized with **Docker Compose**.

## 1. Quick Start (Desktop/VPS)

From the repository root, run the automated setup:

```bash
./docker-setup.sh
```

## 2. Manual `docker-compose.yml` Template

If you prefer manual control, use this baseline template for a production-ready gateway:

```yaml
services:
  mariecoder-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    environment:
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
    volumes:
      - ~/.openclaw:/home/node/.openclaw
    ports:
      - "18789:18789"
    restart: unless-stopped

  # Optional: Enable Docker Sandboxing for agents
  mariecoder-sandbox:
    image: openclaw:local
    profiles: ["sandbox"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: ["tail", "-f", "/dev/null"]
```

> [!TIP]
> Use **Profiles** to toggle advanced features. Run `docker compose --profile sandbox up -d` to enable agent isolation.

---

## 🛠️ Troubleshooting & FAQ (Docker)

### Common Issues

- **`EACCES` on Volumes**: If you see permission errors on `~/.openclaw`, ensure the directory is owned by the user running Docker (UID 1000 in the container).
  ```bash
  sudo chown -R 1000:1000 ~/.openclaw
  ```
- **Port Conflicts**: If port `18789` is already in use, change the mapping in your `docker-compose.yml`:
  ```yaml
  ports:
    - "19000:18789"
  ```
- **OOM Kill**: Building the image requires at least 2GB of RAM. If `pnpm install` fails, increase your Docker Desktop memory allocation.

### Frequently Asked Questions

**Q: Do I need Docker to run MarieCoder?**  
A: No. Docker is optional but recommended for isolated or remote deployments.

**Q: Can I run my own models?**  
A: Yes. Set `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest` and configure your local Ollama or LocalAI endpoint in the provider settings.

**Q: Is my data secure?**  
A: Yes. All data stays in your volumes. With **SecretRef**, your API keys are never stored in plaintext.
