# Running OpenDots (self-hosted)

OpenDots runs locally. The only required external dependency is an
OpenAI-compatible LLM provider. CopilotKit Intelligence is not used: conversations,
threads, replay, Automatic Learning, and Slack all run on this machine.

## Local development

Use **Node.js 24** and **npm**:

```sh
npm ci
cp .env.example .env
# edit .env (model provider at minimum)
npm run dev
```

`npm run dev` starts the API on `http://127.0.0.1:4310` and Vite on
`http://127.0.0.1:5173`. Production:

```sh
npm run build
npm start
```

`npm start` serves the built client and the API from one process. SQLite is the
only data store.

## Model provider

The original TanStack AI agent loop is unchanged; only the adapter configuration
is provider-independent.

| Variable                | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `AI_PROVIDER`           | `openai-compatible` (default) or `ollama`                                        |
| `AI_BASE_URL`           | Base URL of the OpenAI-compatible API (without `/chat/completions`)              |
| `AI_API_KEY`            | Server-side credential. Ollama accepts the placeholder `ollama`.                 |
| `AI_MODEL`              | Exact model id exposed by the provider                                           |
| `AI_MAX_OUTPUT_TOKENS`  | Optional completion-token cap (default 2200)                                     |
| `AGENT_MAX_EVENT_BYTES` | Optional per-event journal limit (default 524288); oversized events fail the run |

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` are still read as
fallbacks; `AI_*` wins when both are present.

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

Do not expose Ollama (port 11434) to untrusted networks.

### Per-Dot models

Open **Settings → Specialist → Model override** and enter the provider's exact
model id. Leave it blank to use `AI_MODEL`. OpenDots never switches provider or
model silently.

## Conversations, threads, and data

Every conversation is stored in `DATABASE_PATH` (default
`data/opendots.sqlite`): messages, tool calls, replayable AG-UI events, approval
receipts, background tasks, Learning state, and Slack subscriptions. See
[DATABASE.md](DATABASE.md).

### Durability and recovery

- A run is recorded as `running` before the model is called; events are appended
  to `agent_run_events` in small transactions while streaming, and the transcript
  is checkpointed at most every 250 ms/64 events.
- Terminal events, final status, and the final transcript are committed before
  the client receives `RUN_FINISHED`. If that write fails the client receives
  `RUN_ERROR`; OpenDots never reports an unsaved run as successful.
- After a crash, runs still marked `running` become `interrupted` at startup.
  Their committed events remain replayable; nothing is retried automatically.
- Memory stays bounded during streaming (512 recent events in RAM); full history
  lives in SQLite and is replayed in 500-row chunks when a client reconnects.
- Conversations have no framework retention limit and survive restarts.

### Conversation management

The sidebar supports search, archived view, pagination, and per-conversation
**Rename**, **Archive/Restore**, and **Delete** (with confirmation). Deleting is
refused while a run is active, cancels scheduled tasks bound to the conversation,
and removes its transcript, runs, journal events, approvals, captures, call
records, Learning evidence, and Slack subscriptions. Pages are kept.

Page chat, voice compute, scheduled tasks, and Slack all write to the same
conversation store. Archived conversations reject new turns until restored.

## Local network access

OpenDots binds to `127.0.0.1` by default. To reach it from another device:

```env
HOST=0.0.0.0
OWNER_TOKEN=a-random-string-of-at-least-24-characters
APP_ORIGIN=http://192.168.1.x:4310
```

Startup refuses an external binding without a long `OWNER_TOKEN`. The token is
required on every API request and is the browser login. Keep SQLite, Ollama, the
browser service, and the OpenBot supervisor on a trusted network.

## Pages and page conversations

Pages, revision checks, autosave, slash commands, and page-specific
conversations are unchanged. A page conversation is a normal local thread; saving
a conversation as a page reads its local transcript.

## Browser tool

`WEB_SEARCH_PROVIDER` accepts:

- `parallel` (default) — searches and URL reads through Parallel.
- `browser` — a separate read-only browser service; set `BROWSER_URL` and
  `BROWSER_SECRET` (24+ characters, shared with the browser container).
- `disabled` — no public-web tools.

```sh
docker compose -f compose.computers.yml up -d browser
```

## Composio

`COMPOSIO_API_KEY` enables connected apps. Toolkit allowlists and per-Dot
permissions are configured in the Dot dialog. Tool arguments and results pass
through Composio and the app provider.

## Persistent Dot computers

See [COMPUTERS.md](COMPUTERS.md). The OpenBot isolation model is unchanged: one
container per Dot, explicit permissions, owner takeover, and an action audit log.
Keep `COMPUTER_SUPERVISOR_TOKEN` and `COMPUTER_TOKEN` different, random, and
server-side.

## Slack (direct integration)

Slack no longer goes through CopilotKit Intelligence Channels. OpenDots connects
directly with Socket Mode using the official Slack SDKs; no public HTTPS endpoint
is needed. See [SLACK.md](SLACK.md) for app creation, scopes, and event
subscriptions. Minimal configuration:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_NAME=opendots
SLACK_TEAM_ID=T01234567
SLACK_USER_IDS=U01234567
# SLACK_DOT_ID=<dot id, defaults to the first Dot>
```

Workspace, channel, and user allowlists apply. A mention subscribes the thread;
later messages in that thread continue the same local conversation. Approval
cards remain web-only (as upstream).

## Calls

Calls use WebRTC speech with a delegated compute turn in the same conversation:

```env
VOICE_API_KEY=...
VOICE_MODEL=...
VOICE_NAME=marin
```

Speech audio is sent to the configured speech provider. Compute turns stay local
and are written to the conversation transcript.

## Containers

`compose.yml` runs the application; `compose.computers.yml` adds the isolated
browser and OpenBot services. Mount a volume for `DATABASE_PATH` so conversations
and Learning state survive container replacement. Docker is optional for the app
and required only for computer services.

```sh
docker compose up -d
# Stop services while retaining saved data.
docker compose down
```

## Automatic Learning

The workflow is preserved locally: containers group evidence from enrolled
conversations, the configured model proposes draft skills, and the owner reviews
and publishes them. See [LEARNING.md](LEARNING.md).

In the Dot dialog, enter or pick a container ID under **Automatic Learning**,
enable **Use published skills**, and use **Review evidence and skills** to
analyze, review, publish, or reject proposals.

**Settings → Automatic Learning** can enable background analysis and set the
minimum interval (5 minutes to one week, default 60). It is off by default and
respects readiness, new evidence, container/workspace pause, and one analysis per
scheduler tick. Automatic analysis only creates drafts; publishing is always
manual. The review panel shows the automatic status, next eligible time, last run
status, and last error.

## Development checks

```sh
npm run typecheck
npm test
npm run lint
```

Automated tests use a local OpenAI-compatible fixture server and a fake Slack
client. They never call a paid provider. Live DeepSeek/Ollama, OpenBot, speech,
Parallel, Composio, and Slack validation is intentionally deferred.
