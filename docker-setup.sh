#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"

echo "==> OpenClaw Docker Strategy"

# Ensure docker is available
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker not found. Please install Docker." >&2
  exit 1
fi

# Build if local image requested
if [[ "$IMAGE_NAME" == "openclaw:local" ]]; then
  echo "==> Building local image: $IMAGE_NAME"
  docker build -t "$IMAGE_NAME" "$ROOT_DIR"
fi

# Start OpenClaw
echo "==> Starting OpenClaw via Docker Compose"
OPENCLAW_IMAGE="$IMAGE_NAME" docker compose up -d

echo ""
echo "OpenClaw is starting in the background."
echo "Access the Control UI at: http://localhost:18789"
echo "Check logs with: docker compose logs -f"
echo ""
echo "Note: Bootstrapping (token/key generation) happens automatically inside the container."
