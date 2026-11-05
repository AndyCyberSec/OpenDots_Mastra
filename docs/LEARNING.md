# Automatic Learning (local)

OpenDots keeps the original Automatic Learning workflow — conversations feed a
container, the container proposes skills, the owner reviews them, and published
skills are delivered to Dots — but every step now runs locally. CopilotKit
Intelligence is not involved and no conversation evidence leaves the machine
except through your configured model provider when you press **Analyze** or when
you explicitly enable automatic analysis in Settings.

## How it maps to the original feature

| Original (CopilotKit Intelligence)                               | Local replacement                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Learning container in the Intelligence project                   | `learning_containers` row in `DATABASE_PATH`                                                                        |
| Dot's container ID (frozen per conversation)                     | Same field and same freeze-on-create behaviour (`thread_bindings.learningContainerId`)                              |
| Evidence collection from enrolled conversations                  | `learning_evidence`, written after each completed turn (web chat, page chat, voice compute, scheduled tasks, Slack) |
| Manual/scheduled analysis and skill proposals                    | **Analyze evidence** (manual) or the opt-in background scheduler; one model call over bounded recent evidence       |
| Review and publish in the Intelligence dashboard                 | Learning panel: preview, Publish, Reject, Unpublish, Delete                                                         |
| Delivery through `learnedSkills` + `copilotkit_load_skill` tools | Published catalogue added to the system prompt plus the same two tool names, reading local rows                     |
| Delivery requires the remote container; failures fail the turn   | Missing container fails the turn with a clear error                                                                 |

## Automatic analysis (opt-in)

Analysis can run on the existing background scheduler instead of a second timer.
It is **disabled by default** and must be enabled in **Settings → Automatic
Learning**:

- **Analyze Learning evidence automatically** — master switch (`settings.learningAutoAnalyze`).
- **Minimum minutes between analyses** — per-container interval
  (`settings.learningIntervalMinutes`, default 60, range 5–10080).

A container becomes eligible only when all of the following hold:

1. automatic analysis is enabled and the workspace is not paused;
2. the container is not paused and its readiness threshold is met
   (`threadCount >= threshold`, default 15);
3. it has evidence newer than the newest evidence already analyzed
   (`analyzedEvidenceAt`);
4. the interval since the last attempt/analysis has elapsed
   (`lastAutoAttemptAt`, `lastAnalyzedAt`).

Each scheduler tick analyzes **at most one** container, so a single tick cannot
issue a burst of model calls. Concurrent analyses of the same container are
rejected, including a manual analysis started while an automatic one runs.
Failures are stored as a sanitized `lastAutoError`, the attempt time is still
recorded (no retry storm), and the next attempt waits for the interval. A
`running` analysis left by a crash is reported as failed after restart and is not
retried automatically. Pausing the workspace or the container stops automatic
analysis immediately; manual analysis stays available.

**Automatic analysis can only create drafts.** It never publishes, unpublishes,
edits a published skill, or changes a Dot's instructions, permissions, or tools.
The Learning panel shows the automatic status, next eligible time, last run
status, and last error. The readiness count and threshold are still displayed.

## Owner workflow

1. **Create a container.** In the Dot dialog under **Automatic Learning**, type a
   new container ID (1–64 lowercase letters, numbers, single hyphens) such as
   `research-workflow`. Saving creates the local container. Existing containers
   are offered in the field's datalist.
2. **Enrol conversations.** The ID is frozen into each new conversation. Page
   chat, voice compute, scheduled tasks, and new Slack threads inherit it.
   Changing or clearing the Dot's ID affects only new conversations.
3. **Collect evidence.** Every completed turn adds the owner prompt and the
   assistant answer to the container (de-duplicated by message ID, bounded by
   `LEARNING_EVIDENCE_LIMIT`, default 2000 rows). Turning delivery off does not
   stop evidence collection.
4. **Analyze.** Open **Review evidence and skills**, press **Analyze evidence**
   (manual, always available). The configured model receives bounded evidence
   and must return up to three draft skills as JSON. Drafts are never published
   automatically. Pause the container to stop analysis. With automatic analysis
   enabled in Settings, the background scheduler does the same work within the
   configured interval and readiness rules.
5. **Review.** Each draft shows a description and its instructions. Publish keeps
   it available to Dots; Reject archives it; you can Unpublish or Delete later.
6. **Deliver.** With **Use published skills** enabled on the Dot, subsequent turns
   in enrolled conversations receive the published catalogue and the
   `copilotkit_load_skill` / `copilotkit_read_skill_file` tools.

## Safety boundaries

- The model only proposes text. It cannot publish, change permissions, create
  tools, or modify its own configuration.
- The analysis prompt explicitly forbids proposals that expand permissions,
  bypass approvals, contact services without authorization, or self-modify.
- Skill names are validated; duplicates are skipped.
- Skill content is reference material, never higher-priority instructions.
- Only the owner API can review or publish; routes sit behind the existing owner
  token, origin, and content-type guards.
- Evidence is local and bounded; conversations keep their full history in
  `agent_threads`/`agent_runs` with no retention limit.

## API

All routes are owner-only (`/api` guards apply):

| Method   | Path                                    | Purpose                                                               |
| -------- | --------------------------------------- | --------------------------------------------------------------------- |
| `GET`    | `/api/learning/containers`              | Container summaries (evidence, threads, drafts, published, readiness) |
| `POST`   | `/api/learning/containers`              | Create `{ id, name? }`                                                |
| `GET`    | `/api/learning/containers/:id`          | Summary, skills, recent analysis runs                                 |
| `PATCH`  | `/api/learning/containers/:id`          | `{ name?, paused?, threshold? }`                                      |
| `GET`    | `/api/learning/containers/:id/evidence` | Last 50 evidence messages                                             |
| `POST`   | `/api/learning/containers/:id/analyze`  | Run local analysis                                                    |
| `POST`   | `/api/learning/skills/:id/actions`      | `{ action: "publish" \| "reject" }`                                   |
| `DELETE` | `/api/learning/skills/:id`              | Delete a skill                                                        |

## What remains manual

- **Publishing** is always manual: the scheduler only writes drafts.
- **Ready-skill edits** are not automatic: the model cannot modify published
  skills.
- **Intervals** are owner-set; there is no per-container cron and no cloud
  Learning schedule. Automatic analysis shares the existing background runner,
  which ticks once per second and skips when a previous analysis is in flight.

## Tests

`tests/learning.test.ts` covers containers, evidence bounding and de-duplication,
analysis proposals, failures, publishing, delivery tools, permissions, and
overlapping manual analyses. `tests/learning-auto.test.ts` covers the disabled
default, one-container-per-tick, readiness, unchanged evidence, interval,
paused container/workspace, failure recording and recovery, concurrency, and
abort. `tests/learning-delivery.test.ts` covers DotAgent catalogue/tool delivery,
missing containers, and evidence capture. `tests/learning-routes.test.ts` covers
the owner HTTP workflow and `tests/settings.test.ts` the settings validation.
