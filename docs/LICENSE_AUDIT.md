# License audit

Assessed for the self-hosted deployment described in
[MASTRA_MIGRATION.md](MASTRA_MIGRATION.md). The rule: every mandatory component
must be Apache-2.0, MIT, ISC, BSD, or an equivalent permissive license, and no
mandatory component may require a commercial account, activation server, or
hosted quota.

Verified against the versions resolved in `package-lock.json`
(Node 24, npm 11). Licenses were read from each package's `package.json` inside
`node_modules` and cross-checked with the npm registry metadata.

## Direct runtime dependencies

| Package                        | Version        | License    | Self-hosted notes                                                           |
| ------------------------------ | -------------- | ---------- | --------------------------------------------------------------------------- |
| `@mastra/core`                 | 1.82.0         | Apache-2.0 | In-process agent runtime. No license check, no account.                     |
| `@mastra/memory`               | 1.41.0         | Apache-2.0 | Local memory; no hosted dependency unless you configure one.                |
| `@mastra/libsql`               | 1.29.0         | Apache-2.0 | Local SQLite access.                                                        |
| `@mastra/client-js`            | 1.59.0         | Apache-2.0 | Peer dependency of the AG-UI bridge (used only for remote agents).          |
| `@ag-ui/mastra`                | 1.1.6          | Apache-2.0 | Mastra ↔ AG-UI bridge (streaming, tools, interrupts).                       |
| `@ag-ui/core`                  | 0.0.59         | MIT        | Protocol types and event schema.                                            |
| `@ag-ui/client`                | 0.0.59         | MIT        | AG-UI client primitives used by the bridge/runtime.                         |
| `@copilotkit/runtime`          | 1.75.0         | MIT        | Local SSE transport and thread endpoints. Intelligence is not instantiated. |
| `@copilotkit/core`             | 1.75.0         | MIT        | Client-side AG-UI agent plumbing used by the React SDK.                     |
| `@copilotkit/react-core`       | 1.75.0         | MIT        | React hooks for chat, tools, and the thread list.                           |
| `@modelcontextprotocol/sdk`    | 1.31.0         | MIT        | MCP client.                                                                 |
| `@composio/core`               | 0.22.0         | ISC        | Optional; requires the operator's own Composio key.                         |
| `hono` / `@hono/node-server`   | 4.13.x / 2.1.x | MIT        | HTTP server.                                                                |
| `react`, `react-dom`           | 19.3.0         | MIT        | UI.                                                                         |
| `zod`                          | 4.6.7          | MIT        | Validation.                                                                 |
| `rxjs`                         | 7.8.1          | Apache-2.0 | Streams.                                                                    |
| `lucide-react`                 | 1.48.0         | ISC        | Icons.                                                                      |
| `react-markdown`, `remark-gfm` | 10.x / 4.x     | MIT        | Markdown rendering.                                                         |
| `@tiptap/*`                    | 3.31.3         | MIT        | Page editor.                                                                |
| `playwright`                   | 1.63.0         | Apache-2.0 | Browser automation for the optional browser service.                        |

## Packages that require commercial licensing or a hosted service

| Package                                                   | Used?                                                 | Assessment                                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@copilotkit/license-verifier` (transitive)               | Present as a transitive dependency of the MIT runtime | Only consulted by `CopilotIntelligenceRuntime`. This fork constructs `CopilotSseRuntime`, so no license token is required or checked. No activation request is made. |
| CopilotKit Intelligence client (`CopilotKitIntelligence`) | Not instantiated                                      | Replaced by Mastra + local SQLite. No key is read; `CPK_INTELLIGENCE_API_KEY` / `INTELLIGENCE_API_KEY` are ignored.                                                  |
| Mastra Cloud / Mastra Enterprise                          | Not used                                              | Only the Apache-2.0 core, memory, and libsql packages are imported. No `@mastra/cloud` dependency.                                                                   |
| `@copilotkit/channels*`                                   | Removed                                               | Managed Channels require Intelligence. Slack support was removed rather than keeping a commercial dependency.                                                        |

## Optional integrations

These are never required for the application to run, and each needs the
operator's own credentials:

- **Model providers** — DeepSeek, Ollama, or any OpenAI-compatible endpoint.
  Provider terms and API costs are yours; OpenDots itself imposes no quota.
- **Parallel** — public-web research. `WEB_SEARCH_PROVIDER=disabled` removes it.
- **Composio** — connected apps. Requires a Composio account.
- **OpenAI Realtime** — optional voice calls. Requires an OpenAI key.
- **OpenBot** — optional isolated computers (separate project, Apache-2.0).

## Verification performed

1. Read the license field of every direct dependency in `node_modules`.
2. Confirmed no direct dependency is proprietary, source-available-only, or
   commercial-use-restricted.
3. Confirmed the application starts and serves `/api/copilotkit/info` with no
   Intelligence key, no license token, and no outbound network access
   (`tests/ai-config.test.ts`, `tests/telemetry.test.ts`).
4. Confirmed persistence uses only local SQLite files (`agent_threads`,
   `agent_runs`, `mastra_*`) with no retention caps.
5. Confirmed telemetry from the bundled runtime is disabled before import
   (`tests/telemetry.test.ts`).
6. Re-verify after dependency upgrades: `npm run knip`, `npm test`, and a review
   of any newly added `@copilotkit`, `@mastra`, or provider package.

## Attribution

- OpenDots (upstream): MIT, © CopilotKit and contributors. Original
  `LICENSE`, copyright notices, and README attribution are preserved.
- Mastra: Apache-2.0.
- AG-UI: MIT.
- CopilotKit runtime and React SDK: MIT.

This document is an engineering assessment, not legal advice. Review it with
counsel before distributing a commercial derivative.
