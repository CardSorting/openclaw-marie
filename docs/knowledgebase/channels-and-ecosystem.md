# 📱 Ecosystem & Channel Integration

MarieCoder isn't just a CLI; it's a complete engineering ecosystem with multiple logical nodes and messaging interfaces.

## 📱 Ecosystem Components

### macOS App (Menu Bar)

The powerhouse control plane for your desktop. Features Voice Wake, PTT, and a remote gateway bridge over SSH.

### iOS & Android Nodes

Turn your mobile devices into powerful sensors. Expose camera, location, and system notifications to your agent with end-to-end encryption. Exposes Connect/Chat/Voice tabs plus Canvas, Camera, Screen capture, and Android device command families.

### Browser Control

Dedicated managed Chromium instance with CDP control. Capture snapshots, automate uploads, and scrape with precision.

---

## 🔌 Messaging Channels

MarieCoder connects to high-impact messaging surfaces. Configuration is managed via the `channels` object in `~/.openclaw/openclaw.json`.

### [WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

- **Login:** `pnpm openclaw channels login` (stores creds in `~/.openclaw/credentials`).
- **Control:** Allowlist via `channels.whatsapp.allowFrom`.

### [Telegram](https://docs.openclaw.ai/channels/telegram)

- **Configuration:** Set `TELEGRAM_BOT_TOKEN` or `channels.telegram.botToken`.
- **Options:** Optional `channels.telegram.groups` for group specific policies.

### [Slack](https://docs.openclaw.ai/channels/slack)

- **Authentication:** Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.

### [Discord](https://docs.openclaw.ai/channels/discord)

- **Configuration:** Set `DISCORD_BOT_TOKEN`.
- **Media Support:** Adjust `channels.discord.mediaMaxMb` as needed.

### [BlueBubbles (iMessage)](https://docs.openclaw.ai/channels/bluebubbles)

- **Recommended Integration:** Configured via `channels.bluebubbles.serverUrl` + `channels.bluebubbles.password`.

### [iMessage (Legacy)](https://docs.openclaw.ai/channels/imessage)

- Legacy macOS-only integration via `imsg` (Messages must be signed in).

### [Microsoft Teams](https://docs.openclaw.ai/channels/msteams)

- Configure Teams app + Bot Framework and add an `msteams` config section.

### [WebChat](https://docs.openclaw.ai/web/webchat)

- Uses the Gateway WebSocket directly.

---

## 🌐 Remote Access & Operations

### Remote Gateway

It’s perfectly fine to run the Gateway on a small Linux instance. Clients (macOS app, CLI, WebChat) can connect over **Tailscale Serve/Funnel** or **SSH tunnels**.

- **Gateway host** runs the exec tool and channel connections.
- **Device nodes** run local actions (`system.run`, camera, location) via `node.invoke`.

### Agent to Agent Coordination

- `sessions_list` — discover active sessions (agents) and their metadata.
- `sessions_history` — fetch transcript logs for a session.
- `sessions_send` — message another session; optional reply-back ping-pong.
