# Colabdroid — Google Colab CLI Backend & Web Terminal

Full-featured Google Colab backend and web terminal powered by **libghostty** WebAssembly engine and [google-colab-cli](https://github.com/googlecolab/google-colab-cli). Designed for mobile Android devices (WebView / APK) and desktop browsers.

---

## Highlights & Features

- **libghostty Web Engine**: Upgraded terminal emulator powered by Ghostty's core VT100 parser compiled to WebAssembly (`ghostty-web`). Fast Canvas rendering, correct Unicode/grapheme cluster support, truecolor, and modern terminal sequence processing.
- **Persistent PTY SSH Shell**: Real Linux shell (`colab ssh`) running inside `node-pty`. Shell sessions persist in the background across network drops, phone screen locks, or APK minimizing (`PTY_KEEP_MS`), replaying terminal screen state on reconnect.
- **SSH+ with Tmux**: Dedicated multi-window mode leveraging `tmux` directly within the terminal interface.
- **Line-Exec Mode**: Lightweight fallback mode executing isolated single-line/multi-line commands via `colab exec`.
- **Advanced File Manager**: Complete browser for files on the Colab VM:
  - File upload (multi-part with chunking up to 2GB+) & download.
  - Multi-selection for batch operations (delete, copy, move).
  - Archive creation and extraction (`.zip`, `.tar`, `.tar.gz`, `.tar.bz2`, `.7z`).
  - Interactive archive preview modal without extracting.
- **Google Drive Integration**: Headless mounting of Google Drive with interactive OAuth code authorization.
- **Mobile & Touch Ergonomics**:
  - Movable floating directional keypad (arrows, Home, End, PageUp, PageDown).
  - Virtual modifier buttons (Ctrl, Alt, Shift, Fn shortcuts).
  - Android soft keyboard lock toggle (prevents on-screen keyboard from popping up while navigating with pads).
  - Select mode for effortless touch text selection and copying.
  - Customizable UI typography, scaling, and font sizes.
- **Hardware & System Monitoring**: Real-time telemetry for GPU (VRAM/utilization), RAM, CPU, and disk usage.
- **Security**: Token-gated Web UI (`WEB_TOKEN`) and secret header authentication (`API_KEY`).

---

## Terminal Modes

| Mode | Technology | Description |
|------|------------|-------------|
| **SSH (PTY)** *(Default)* | `colab ssh` + `node-pty` + libghostty WASM | Full interactive PTY session with persistent state. Supports TUI apps (`vim`, `nano`, `htop`, `mc`), persistent directory changes, signals, and background shell persistence. |
| **SSH+** | `colab ssh` + `tmux` | Multiplexed terminal attached to a persistent `tmux` session, ideal for background long-running training jobs. |
| **Line-Exec** | `colab exec` + streaming WS | Simple streaming per-line execution. Each line is an independent cell execution on the Colab VM. |

---

## Requirements

- **Docker** (Ubuntu/Debian base with Python 3.12 + Node.js 20 + OpenSSH client)
- **Persistent Volume** mounted at `/data` (e.g. on Northflank, Railway, Render, or VPS)
- Google account with access to Google Colab
- Strong `API_KEY` for secure access

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | *(empty)* | Shared secret; clients authenticate via `x-api-key` header, query param, or Bearer token. |
| `REQUIRE_API_KEY` | `1` | Enforce API key check. Set to `0` only for local debugging. |
| `WEB_TOKEN` | *(empty)* | Optional secret to protect the Web UI. If set, access requires opening `/?token=WEB_TOKEN`. |
| `PORT` | `8080` | Port for the HTTP and WebSocket server. |
| `COLAB_HOME` / `HOME` | `/data` | Base directory for Colab CLI configs and SSH keys (`/data/.config/colab-cli`). |
| `COLAB_AUTH_TOKEN` | *(empty)* | Bootstrap raw JSON or base64 content for `token.json`. |
| `PTY_KEEP_MS` | `7200000` *(2h)* | Duration in milliseconds to keep detached PTY shells alive after client disconnect. |
| `MAX_PTYS` | `8` | Maximum concurrent PTY shells allowed on the server. |
| `MAX_UPLOAD_MB` | `2048` | Maximum per-file upload size in megabytes for the File Manager. |
| `SSH_KEY_PATH` | `~/.ssh/id_ed25519` | Path to persistent SSH private key for `colab ssh`. |

---

## Deployment

### Deploy on Northflank (or any Docker host)

1. Clone or fork this repository.
2. Create a service in Northflank:
   - **Build Type**: Dockerfile
   - **Port**: `8080` (HTTP with WebSocket support)
3. Attach a Persistent Volume:
   - **Mount Path**: `/data`
4. Set Environment Variables:
   - `API_KEY=<your-secret-key>`
   - `REQUIRE_API_KEY=1`
   - `COLAB_HOME=/data`
   - `HOME=/data`
   - *(Optional)* `WEB_TOKEN=<your-ui-secret>`
5. Deploy. Check health at `https://<your-host>/health` — should return `colabCliOk: true`.

*(See `northflank.json` for a template configuration)*

### Local Run with Docker

```bash
mkdir -p data
docker build -t colabdroid .
docker run --rm -it \
  -p 8080:8080 \
  -e REQUIRE_API_KEY=0 \
  -e COLAB_HOME=/data \
  -e HOME=/data \
  -v "$(pwd)/data:/data" \
  colabdroid
```

Open `http://localhost:8080` in your browser.

---

## Initial Setup & Google Authentication

1. Open the Web UI → navigate to the **AUTH & CONFIG** tab.
2. In **Connection Settings**:
   - **Base URL**: leave empty if accessing from the same origin, or set to your backend URL.
   - **API Key**: enter your configured `API_KEY`.
   - Click **[SAVE & APPLY]**.
3. In **Google Colab Authentication**:
   - Click **[GENERATE GOOGLE LOGIN LINK]**.
   - Open the provided Google authentication link in your browser and authorize the application.
   - Copy the verification code (`4/0...`) and paste it into the code input field.
   - Click **[SUBMIT CODE]**.
4. Once authenticated, switch to the **SESSIONS** tab, create or select a Colab instance, and start using the terminal!

---

## Android APK / WebView Integration

When packaging or running inside the Colabdroid Android APK:
1. Open the app settings or **AUTH & CONFIG** tab.
2. Configure:
   - **Base URL**: `https://<your-deployed-host>`
   - **API Key**: `<your-api-key>`
3. Click **[SAVE & APPLY]** and **[TEST /HEALTH]**.
4. The terminal interface will connect to the backend WebSocket and provide hardware-accelerated **libghostty** emulation with full touch controls.

---

## API Summary

All endpoints require `x-api-key: <API_KEY>` (or `?api_key=...`) when `REQUIRE_API_KEY=1`.

- **Health & Info**:
  - `GET /health` — Service status, CLI version, and environment checks.
  - `GET /api/status` — Backend status and active session info.
- **Authentication**:
  - `GET /api/auth/status`, `GET /api/auth/login-url` — Check auth status / retrieve login URL.
  - `POST /api/auth/code`, `POST /api/auth/token` — Submit OAuth code or raw token.
  - `DELETE /api/auth` — Log out and clear saved credentials.
- **Sessions**:
  - `GET /api/sessions`, `POST /api/sessions` — List or create Colab VM sessions.
  - `GET /api/sessions/:name`, `DELETE /api/sessions/:name` — Inspect or stop a session.
- **WebSockets**:
  - `WS /pty?session=NAME&mode=ssh&cols=80&rows=24&sid=ID` — Real persistent PTY shell (libghostty).
  - `WS /terminal?session=NAME` — Streaming Line-Exec terminal.
- **File Manager**:
  - `GET /api/files?path=/content` — List directory contents with metadata.
  - `GET /api/files/download?path=...` — Download file.
  - `POST /api/files/upload` — Upload files with progress.
  - `POST /api/files/archive`, `POST /api/files/extract`, `POST /api/files/archive/list` — Archive management.
- **Drive & System**:
  - `POST /api/drivemount/start`, `POST /api/drivemount/confirm` — Google Drive interactive mount.
  - `GET /api/gpu`, `GET /api/system`, `GET /api/usage` — Hardware utilization metrics.

---

## License

[MIT](file:///content/Colabdroid/package.json#L23)
