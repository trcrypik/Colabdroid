# Google Colab CLI — Northflank Backend

Node.js API + Web UI that drives [google-colab-cli](https://github.com/googlecolab/google-colab-cli) for the **Colab Terminal** Android app.

## Important: terminal mode

This is a **line-exec** terminal, not a persistent SSH/PTY shell:

- each command → one `colab exec` on the Colab VM
- `cd`, env vars, and shell state **do not** carry across lines like in a real bash session
- use multi-line `%%bash` blocks or a single compound command when you need shared state

## Requirements

- Docker (Python **3.12** + Node 20 in the image)
- Northflank (or any Docker host) with a **persistent volume** at `/data`
- Google account that can use Colab
- Strong `API_KEY` (required by default)

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEY` | **Yes** (prod) | Shared secret; clients send `x-api-key` |
| `REQUIRE_API_KEY` | no | Default `1`. Set `0` only for local debug |
| `PORT` | no | Default `8080` |
| `COLAB_HOME` / `HOME` | yes on NF | Set to `/data` so tokens survive restarts |
| `COLAB_AUTH_TOKEN` | no | Bootstrap `token.json` (raw JSON or base64) |

## Northflank deploy

1. Push the `backend/` folder to a Git repo (or build the Dockerfile from this directory).
2. Create a service: **Dockerfile** build, port **8080** public HTTP (WebSocket supported).
3. Add volume: mount path **`/data`**.
4. Env:
   - `API_KEY=<long-random-secret>`
   - `REQUIRE_API_KEY=1`
   - `COLAB_HOME=/data`
   - `HOME=/data`
5. Deploy. Open `https://<host>/health` — should show `colabCliOk: true`, `apiKeyRequired: true`.

See `northflank.json` for a sample shape (adjust to the NF UI if the JSON is not imported 1:1).

## Google auth (one-time)

1. Open the service URL → tab **AUTH & CONFIG**.
2. Save connection: Base URL empty (same origin), API key = your `API_KEY`.
3. **Generate Google login link** → approve → paste `4/0...` code → Submit.
4. Or paste full `token.json` content.

Tokens are stored under `$HOME/.config/colab-cli/` (i.e. `/data/.config/colab-cli` when `HOME=/data`).

## API (summary)

All `/api/*` require header `x-api-key: <API_KEY>` when `API_KEY` is set.

- `GET /health` — public health + CLI version
- `GET /api/auth/status`, `GET /api/auth/login-url`, `POST /api/auth/code`, `POST /api/auth/token`
- `GET/POST /api/sessions`, `DELETE /api/sessions/:name`
- `POST /api/exec` — `{ session, code, isBash, timeout }`
- `GET /api/gpu?session=`, `GET /api/system?session=`, `GET /api/files`
- `WS /terminal?session=NAME&api_key=KEY` — streaming line-exec

## Local run

```bash
export REQUIRE_API_KEY=0   # or set API_KEY=dev
export COLAB_HOME=$PWD/data HOME=$PWD/data
mkdir -p data
docker build -t colab-backend .
docker run --rm -p 8080:8080 -e REQUIRE_API_KEY=0 -e COLAB_HOME=/data -e HOME=/data -v $PWD/data:/data colab-backend
```

## Android APK

Bundled WebView loads `assets/index.html`. In **AUTH & CONFIG** set:

- Base URL = `https://your-northflank-host`
- API key = same as server `API_KEY`

Then **Save connection** and **Test /health**.
