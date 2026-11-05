# Slack (direct integration)

The upstream template used CopilotKit Intelligence Channels, which managed the
Slack app, entitlements, and delivery. This fork replaces that with a **direct
Slack integration** built on the official MIT-licensed Slack SDKs:

- `@slack/socket-mode` — receive events over Socket Mode (no public HTTPS URL).
- `@slack/web-api` — post replies and resolve the channel.

CopilotKit Intelligence is not involved. Slack remains optional: OpenDots runs
fully without it.

## What is preserved

| Upstream behaviour             | Local implementation                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace allowlist            | `SLACK_TEAM_ID` must match `auth.test` and every event                                                                                                |
| User allowlist                 | `SLACK_USER_IDS` (comma-separated Slack user IDs)                                                                                                     |
| Channel restriction            | Bot only listens to `SLACK_CHANNEL_NAME` / `SLACK_CHANNEL_ID`                                                                                         |
| Dot selection                  | `SLACK_DOT_ID`, defaulting to the first Dot                                                                                                           |
| Conversation continuity        | One local conversation per Slack thread: `slack:<channel>:<thread_ts>`                                                                                |
| Mention starts a thread        | An `app_mention` subscribes the thread and answers                                                                                                    |
| Follow-ups stay in the thread  | Plain messages in a subscribed thread continue the same conversation                                                                                  |
| Pause                          | While the workspace is paused the bot replies with a pause notice and does not run                                                                    |
| Tool permissions and approvals | Same server-side permission checks as web chat; approval-gated MCP tools are unavailable in Slack (the Dot asks the owner to continue in the web app) |
| No credential leakage          | Errors are logged and posted as sanitized text only                                                                                                   |

## Create the Slack app

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode**: enable it and create an app-level token with
   `connections:write` → this is `SLACK_APP_TOKEN` (`xapp-...`).
3. **OAuth scopes (bot)**: `app_mentions:read`, `chat:write`, `channels:history`
   (and `groups:history` for private channels), `channels:read`.
4. **Event subscriptions**: `app_mention` and `message.im`/`message.channels`
   (the adapter handles `app_mention` and `message`).
5. Install the app, invite the bot to the target channel, and copy the bot token
   (`xoxb-...`) → `SLACK_BOT_TOKEN`.
6. Find the channel ID (or use the channel name without `#`) and your Slack user
   ID, then set the environment:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_NAME=opendots
SLACK_TEAM_ID=T01234567
SLACK_USER_IDS=U01234567,U07654321
# SLACK_DOT_ID=<dot id>
```

Restart the app. **Settings → Service setup** shows the local Slack status:
`not_configured`, `setup_required`, `starting`, `online`, or
`activation_failed`.

## Behaviour details

- Events from other workspaces, channels, or users are ignored.
- Bot messages and edits/deletes (`subtype`) are ignored, except
  `thread_broadcast`.
- Mentions always answer and subscribe the thread. Plain messages only continue
  subscribed threads, matching the upstream "subscribe on mention" behaviour.
- Messages sent before the integration started are not replayed.
- Turns are serialized per Slack thread so replies keep their order.
- Replies are posted in the Slack thread; the full turn is also stored in the
  local conversation, so it appears in the web app.
- Slack turns are recorded as Automatic Learning evidence when the conversation
  has a container (see [LEARNING.md](LEARNING.md)).

## Development and tests

Live Slack is **not** exercised by the automated tests. `tests/slack.test.ts`
injects a fake `SlackClient` and covers:

- start-up, auth, and channel resolution;
- status transitions and activation failure;
- mentions, subscriptions, and follow-up messages;
- workspace/channel/user allowlists, bot and subtype filtering;
- pause behaviour and safe error replies;
- per-thread serialization.

To validate a real workspace later, configure the variables above and send a
mention in the allowlisted channel.
