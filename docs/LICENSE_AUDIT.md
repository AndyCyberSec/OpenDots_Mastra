# License audit

Assessment for this self-hosted branch ([FEATURE_PARITY.md](FEATURE_PARITY.md)).
Rule: every mandatory component must be permissively licensed (Apache-2.0, MIT,
ISC, BSD, or equivalent), with no mandatory commercial account, activation
server, or hosted quota. The only mandatory external service is the operator's
chosen LLM provider.

Versions as resolved in `package-lock.json`. Licenses were read from each
package's `package.json` in `node_modules` and cross-checked with the registry.

## Direct runtime dependencies

| Package                         | Version        | License    | Notes                                                                                      |
| ------------------------------- | -------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `@tanstack/ai`                  | 0.63.0         | MIT        | Original agent loop; kept.                                                                 |
| `@tanstack/ai-openai`           | 0.25.1         | MIT        | OpenAI-compatible adapter.                                                                 |
| `@copilotkit/runtime`           | 1.75.0         | MIT        | AG-UI transport in **local SSE mode** and thread endpoints. Intelligence not instantiated. |
| `@copilotkit/core`              | 1.75.0         | MIT        | Client-side AG-UI plumbing used by the React SDK.                                          |
| `@copilotkit/react-core`        | 1.75.0         | MIT        | React hooks for chat, tools, thread list.                                                  |
| `@ag-ui/client` / `@ag-ui/core` | 0.0.59         | MIT        | AG-UI protocol.                                                                            |
| `@slack/socket-mode`            | 3.1.1          | MIT        | Direct Slack events (Socket Mode).                                                         |
| `@slack/web-api`                | 8.3.0          | MIT        | Slack Web API.                                                                             |
| `@modelcontextprotocol/sdk`     | 1.31.0         | MIT        | MCP client.                                                                                |
| `@composio/core`                | 0.22.0         | ISC        | Optional; operator's own key.                                                              |
| `hono` / `@hono/node-server`    | 4.13.x / 2.1.x | MIT        | HTTP server.                                                                               |
| `react`, `react-dom`            | 19.3.0         | MIT        | UI.                                                                                        |
| `zod`                           | 4.6.7          | MIT        | Validation.                                                                                |
| `rxjs`                          | 7.8.1          | Apache-2.0 | Streams.                                                                                   |
| `lucide-react`                  | 1.48.0         | ISC        | Icons.                                                                                     |
| `react-markdown`, `remark-gfm`  | 10.x / 4.x     | MIT        | Markdown.                                                                                  |
| `@tiptap/*`                     | 3.31.3         | MIT        | Page editor.                                                                               |
| `playwright`                    | 1.63.0         | Apache-2.0 | Optional browser service automation.                                                       |

## Commercial / hosted components

| Component                                                           | Used?                             | Assessment                                                                                                           |
| ------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CopilotKit Intelligence                                             | **No**                            | Removed. No `CopilotKitIntelligence` instance, no key read, no WebSocket or hosted route.                            |
| `@copilotkit/license-verifier` (transitive)                         | Present transitively but inactive | Only consulted by `CopilotIntelligenceRuntime`. This fork uses SSE mode, so no license token is required or checked. |
| `@copilotkit/channels*`                                             | **Removed**                       | Replaced by the direct Slack adapter.                                                                                |
| Mastra (`@mastra/*`, `@ag-ui/mastra`)                               | **Not in this branch**            | The earlier `feature/mastra-self-hosted` branch used them (Apache-2.0) as a reference; this architecture does not.   |
| Mastra Cloud / CopilotKit Cloud / managed memory / workflow engines | No                                | No hosted orchestration, database, or memory service.                                                                |

## Optional external integrations and costs

None are required for the application to run. Each needs the operator's own
account and is billed by that provider:

| Integration                                        | Activation                     | Cost                                                       |
| -------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| LLM provider (DeepSeek, Ollama, OpenAI-compatible) | Required                       | Provider's pricing (Ollama local is free)                  |
| Parallel web research                              | `WEB_SEARCH_PROVIDER=parallel` | Parallel plan; disable or use the browser service to avoid |
| Browser service                                    | `WEB_SEARCH_PROVIDER=browser`  | Self-hosted, free                                          |
| Composio connected apps                            | `COMPOSIO_API_KEY`             | Composio plan                                              |
| OpenAI Realtime speech                             | `VOICE_API_KEY`                | OpenAI pricing                                             |
| OpenBot computers                                  | `COMPUTER_SUPERVISOR_*`        | Self-hosted, free                                          |
| Slack                                              | `SLACK_*`                      | Slack workspace plan                                       |

## Verification performed

1. Read the license of every direct dependency from `node_modules`.
2. Confirmed no mandatory proprietary or activation-required dependency remains.
3. Confirmed the app serves `/api/copilotkit/info` with no Intelligence key and
   no license token (`tests/ai-config.test.ts`).
4. Confirmed zero outbound network requests for setup/runtime without an
   explicit provider call (`tests/telemetry.test.ts`).
5. Confirmed persistence is local SQLite (`agent_threads`, `agent_runs`,
   learning tables) with no retention cap on conversations.
6. Confirmed the Slack adapter uses only official Slack SDKs (MIT).
7. Re-run `npm run knip`, `npm test`, and review new `@copilotkit`/provider
   packages after dependency upgrades.

## Attribution

- OpenDots (upstream): MIT, © CopilotKit and contributors. `LICENSE`, copyright
  notices, and README attribution are preserved.
- CopilotKit runtime/React SDK: MIT.
- TanStack AI: MIT.
- AG-UI: MIT.
- Slack SDKs: MIT.

Engineering assessment, not legal advice.
