# Setup

OpenDots is self-hosted. There is no account, subscription, license activation,
or hosted conversation service. You need Node.js 24, npm, and access to an
OpenAI-compatible model endpoint (DeepSeek, Ollama, vLLM, LM Studio, OpenRouter,
or a local gateway).

## Quick start

```sh
npm ci
cp .env.example .env
# edit .env
npm run dev
```

`npm run dev` starts the API on `http://127.0.0.1:4310` and Vite on
`http://127.0.0.1:5173`. For a production build:

```sh
npm run build
npm start
```

`npm start` serves the built client and API from one process. SQLite is the only
required data store.

## Model providers

| Variable               | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `AI_PROVIDER`          | `openai-compatible` (default) or `ollama`                               |
| `AI_BASE_URL`          | Base URL of the OpenAI-compatible API (no trailing `/chat/completions`) |
| `AI_API_KEY`           | Server-side credential. Ollama accepts the placeholder `ollama`.        |
| `AI_MODEL`             | Exact model id the provider exposes                                     |
| `AI_MAX_OUTPUT_TOKENS` | Optional completion-token cap (default 2200)                            |

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` are read as fallbacks so
existing deployments keep working. `AI_*` wins when both are present.

### DeepSeek

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=sk-...
AI_MODEL=deepseek-chat
```

### Ollama

```env
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.1
```

Ollama must be reachable from the OpenDots process. Do not expose port 11434 to
untrusted networks.

### Per-Dot models

Open **Settings → Specialist → Model override** and enter the provider's exact
model id. Leave it blank to use `AI_MODEL`. OpenDots never switches provider or
model silently.

## Local network access

OpenDots binds to `127.0.0.1` by default. To reach it from another device:

```env
HOST=0.0.0.0
OWNER_TOKEN=a-random-string-of-at-least-24-characters
```

Startup refuses an external binding without a long `OWNER_TOKEN`. The token is
required on every API request and is the browser login. Add the exact browser
origins to `APP_ORIGIN` (comma separated, including scheme and port). Keep
SQLite, Ollama, the browser service, and the OpenBot supervisor on a trusted
network or behind a firewall/reverse proxy.

## Data

Everything durable lives in `DATABASE_PATH` (default
`data/opendots.sqlite`): Spaces, Dots, pages, conversations, tool calls, approval
receipts, background tasks, and Mastra memory (`mastra_*` tables). Back up that
file (and its `-wal`/`-shm` siblings while the app runs) to capture everything.
See [DATABASE.md](DATABASE.md).

## Calls (optional)

Calls use WebRTC speech with a delegated compute turn in the same conversation:

```env
VOICE_API_KEY=...
VOICE_MODEL=...
VOICE_NAME=marin
```

Speech audio is sent to the configured speech provider. Compute turns stay local
and are written to the conversation transcript.

## Browser research (optional)

`WEB_SEARCH_PROVIDER` accepts:

- `parallel` (default) — searches and URL reads through Parallel.
- `browser` — a separate read-only browser service; set `BROWSER_URL` and
  `BROWSER_SECRET` (24+ characters, shared with the browser container).
- `disabled` — no public-web tools.

```sh
docker compose -f compose.computers.yml up -d browser
```

## Composio (optional)

`COMPOSIO_API_KEY` enables connected apps. Toolkit allowlists and per-Dot
permissions are configured in the Dot dialog. Tool arguments and results pass
through Composio and the app provider.

## Dot computers (optional)

See [COMPUTERS.md](COMPUTERS.md). Computers keep the upstream OpenBot isolation
model: one isolated container per Dot, explicit permissions, owner takeover, and
an action audit log. Keep `COMPUTER_SUPERVISOR_TOKEN` and `COMPUTER_TOKEN`
different, random, and server-side.

## Skills (optional)

Put skill folders in `SKILLS_DIR` (default `./skills`) and enable **Use local
skills** for a Dot. See [SKILLS.md](SKILLS.md).

## Background work

Scheduled tasks run inside their original conversation. If the process stops or a
worker lease expires during a run, the run is marked **Interrupted** and waits for
an explicit retry; OpenDots never repeats a possibly completed action on its own.
See [MASTRA_MIGRATION.md](MASTRA_MIGRATION.md#background-and-scheduled-work).

## Docker

`compose.yml` runs the application; `compose.computers.yml` adds the isolated
browser and OpenBot services. Mount a volume for `DATABASE_PATH` so
conversations and memory survive container replacement. Docker is optional for
the app itself and required only for the computer services.

## Verification

```sh
npm run typecheck
npm test
npm run lint
```
