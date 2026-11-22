# Interface reference

This page lists the MCP tools and the HTTP API that Mission Control exposes. Each entry is taken from the code: the tool definitions in `src/mcp/tools/` and the routers in `src/server/routes/`.

The HTTP API binds to `127.0.0.1` only. Requests are accepted only when the Host header is a loopback name (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), and a cross-site Origin is refused with 403 on non-GET requests.

Common response rules:

- Any error thrown by a handler returns status 400 with `{ "error": "<message>" }`. Individual routes return other statuses where they are listed.
- Host or Origin refusals return 403 with `{ "error": "..." }`. Unknown `/api` paths return 404 with `{ "error": "API endpoint not found" }`.
- JSON bodies are limited to 1 MB; `/api/attachments` accepts up to 32 MB. A larger body returns 400.
- Routes marked "rate limited" return 429 once their per-minute limit is exceeded.
- Paths use `:name` for path parameters. Route ids are the values the server stores; they are not documented here.

## MCP tools

The MCP server lists these tools from `TOOL_DEFS` in `src/mcp/tool-registry.ts`. Each tool returns one text content block that holds pretty-printed JSON. "Project context" means the turn runs inside a project; without it, the search and list tools return an empty array and the read and write tools throw.

| Tool | What it does | Inputs (type, required) | Output |
| --- | --- | --- | --- |
| `gbrain_search` | Full-text search over the project's durable memory pages. | `query` string, required; `limit` number, optional (default 8) | Array of `{ slug, title, score, snippet }` |
| `gbrain_index_search` | Searches the wider memory index: pages, run artifacts and proposals. | `query` string, required | Array of index hits |
| `gbrain_read` | Reads one memory page. | `slug` string, required | `{ slug, title, type, tags, content }` |
| `gbrain_list` | Lists memory pages, optionally by slug prefix. | `prefix` string, optional; `limit` number, optional (default 50) | Array of `{ slug, title, tags }` |
| `gbrain_propose` | Writes a durable memory page at once under `data/memory/pages/`. | `slug`, `title`, `content`, `rationale` strings, required; `tags` string array, `type` string (default `note`), optional | `{ slug, title, status, targetPath, captured: true }` |
| `list_runs` | Lists runs, newest first from the store. | `taskId` string, optional; `limit` number, optional (default 50) | Array of `{ id, taskId, agent, status, startedAt, completedAt, blockedReason }` |
| `read_run` | Reads one artifact of a run. | `runId` string, required; `file` string, optional: `prompt.md`, `log.txt` or `summary.md` (default `summary.md`) | `{ runId, file, content }` |
| `list_tasks` | Lists tasks with their derived legacy status. | `status` string, optional; `limit` number, optional (default 50) | Array of `{ id, title, status, agent, turnCount, branch, runId }` |
| `read_task` | Reads a full task record, including messages. | `id` string, required | Task record (`HarnessTask`); throws if the id is unknown |
| `list_hooks` | Reads the hooks defined in `.harness/hooks.yml`. | none | The parsed hook list |
| `kernel_read` | Reads a kernel policy section. | `section` string, optional | Without `section`: array of section names. With `section`: the section text |
| `list_skills` | Lists approved skills with their descriptions. | none | Skill list |
| `read_skill` | Loads one skill body. | `name` string, required | Skill body text |
| `validate_project_job` | Checks a project job definition against the job schema without saving it. | `job` object, required | `{ valid: true, job }` or `{ valid: false, errors }` |
| `define_project_job` | Validates and saves a project job. | `job` object, required; `projectId` string, optional (defaults to the current project) | `{ ok: true, job }` or `{ ok: false, errors }`; throws if the project is unknown |
| `propose_rule` | Queues a change ticket for a `kernel/` file. | `targetPath`, `title`, `rationale`, `content` strings, required; `workflowId` string, optional | `{ id, status, targetPath }` |
| `propose_skill` | Queues a change ticket for `skills/<name>/SKILL.md`. | `name` (lowercase, dashes), `description`, `body`, `rationale` strings, required; `workflowId` string, optional | `{ id, status, targetPath }` |
| `propose_hook` | Queues a change ticket for a hook file. | `targetPath`, `title`, `rationale`, `content` strings, required; `workflowId` string, optional | `{ id, status, targetPath }` |
| `tech_debt_capture` | Appends an item to the tech-debt ledger that the tech-debt sweep job reads. | `title`, `description` strings, required; `agent` string (`codex` or `claude`), `projectId` string, optional; `targets` array of `{ path, kind }` (`file` or `directory`), optional | `{ id, status: "open", total, projectId? }` |

## HTTP API

Every route below is served under `/api`, except the browser devtools probe in the first table. The method and path columns are the registered route; `Input` lists path parameters, query parameters and body fields. Responses are JSON unless the row says otherwise. Where a response is a domain object, its shape is defined in `src/core/types.ts`.

### Application and state

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/events` | none | Server-Sent Events stream of state changes (`text/event-stream`) | 403 |
| GET | `/.well-known/appspecific/com.chrome.devtools.json` | none | 204 with no body; answers the browser devtools probe | — |
| GET | `/api/state` | none | Aggregate snapshot: root, connectors, tasks, runs, memory pages, autonomy jobs, projects, workflows, stage overrides, in-flight task ids, interactive sessions, editors, settings, agent config, usage snapshots, extensions. Field values depend on the local store | 400 |
| GET | `/api/version` | none | Version status fields and `lastUpdate` | 400 |
| POST | `/api/update/apply` | body `mode`: `now` or `idle`, required | `now`: `{ applying, stopped }`. `idle`: `{ queued, idleQueued }` | 400 if mode is invalid; 409 if self-update is unavailable; 500 if the updater did not start |
| GET | `/api/targets/complete` | query `prefix` string, optional | Path completion candidates | 400 |
| GET | `/api/skills` | none | `{ skills, kernelSections }` | 400 |
| GET | `/api/skills/:name` | path `name` | Skill record | 400 invalid name; 404 not found |
| PUT | `/api/skills/:name` | path `name`; body `content` string, required | Written skill record | 400 invalid name or non-string content; 404 not found |
| GET | `/api/kernel/:section` | path `section` | `{ name, content }` | 404 not found. Rate limited (60/min) |
| PATCH | `/api/settings` | body: any of `defaultAgent` (configured tool id), `theme` (`dark` or `light`), `projectsRoot` (string), `activityThresholds` (`staleMs` at least 30000, `longRunMs` at least 60000) | Updated settings | 400 on invalid values |
| POST | `/api/settings/stage-agents/:stage` | path `stage`; body `agent` (configured tool id), required; `workflowId` string, optional (default `code-feature`) | Updated stage-agent overrides | 400 agent not configured |
| DELETE | `/api/settings/stage-agents/:stage` | path `stage`; query `workflowId`, optional (default `code-feature`) | Updated stage-agent overrides | — |
| POST | `/api/settings/stage-agents/:stage/adopt-legacy` | path `stage`; body `workflowId`, required | Updated stage-agent overrides | 400 missing workflowId |
| POST | `/api/settings/stage-model-pools/:stage` | path `stage`; body `poolId` (registered pool), required; `workflowId` string, optional (default `code-feature`) | Updated stage-pool overrides | 400 invalid pool |
| DELETE | `/api/settings/stage-model-pools/:stage` | path `stage`; query `workflowId`, optional (default `code-feature`) | Updated stage-pool overrides | — |
| POST | `/api/settings/stage-model-pools/:stage/adopt-legacy` | path `stage`; body `workflowId`, required | Updated stage-pool overrides | 400 missing workflowId |

### Tasks and daemon

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/tasks` | body: `CreateTaskInput`; `attachmentIds` string array, optional | 201 with the created task | 400 |
| POST | `/api/tasks/delete` | body `ids` string array | Result of the bulk delete | 400 |
| PATCH | `/api/tasks/:id` | path `id`; body: any of `title`, `description`, `agent`, `effort`, `statusOverride` | Updated task | 400 |
| DELETE | `/api/tasks/:id` | path `id` | Result of the delete | 400 |
| POST | `/api/tasks/:id/approve` | path `id` | Approved task | 400 |
| POST | `/api/tasks/:id/approve-plan` | path `id` | `{ task, turn }` | 400; 409 if the implement turn cannot start |
| POST | `/api/tasks/:id/cancel` | path `id` | Cancelled task | 404 not found; 400 |
| POST | `/api/tasks/:id/requeue` | path `id` | Requeued task | 400 |
| POST | `/api/tasks/:id/resume` | path `id` | Resume result | 409 if the task cannot be resumed; 400 |
| POST | `/api/tasks/:id/turn` | path `id` | Turn result | 409 if no turn can run; 400 |
| POST | `/api/tasks/:id/interactive/complete` | path `id`; body `outcome` (`done` or `blocked`), required; `note` string, optional | `{ completed, outcome, taskId }` | 400 invalid outcome; 409 if no interactive turn is waiting |
| POST | `/api/tasks/:id/bind-repo` | path `id`; body `path` string, required | `{ task, suggestedPath }` | 400 missing path; 404 not found; 409 while the task runs |
| POST | `/api/tasks/:id/open-in-editor` | path `id`; body `editor` (`vscode`, `cursor`, `codex` or `kiro`), required | `{ ok, editor, worktreePath }` | 400 invalid editor; 404 not found; 409 if the editor fails to launch |
| POST | `/api/tasks/:id/workflow-step` | path `id`; body `stepId` string and `action` (`approve`, `jump`, `rollback` or `skip`), required | Updated task | 400 invalid input; 404 no workflow run; 409 action not allowed |
| POST | `/api/tasks/:id/revert-step` | path `id`; body `stepId` required; `message` string, `attachmentIds`, optional; `run` boolean, optional (false skips the turn) | `{ task, turn }` | 400 missing stepId; 404 not found; 409 while running or if the revert fails |
| POST | `/api/tasks/:id/messages` | path `id`; body `author` (`operator`, `agent` or `system`, default `operator`), `body` string, `stepId` string, `noteOnly` boolean, `attachmentIds`, all optional | 201 with `{ message, turn }`. `turn` is `null` for agent or note-only messages; `execution: "running"` when delivered into a live turn | 400 |
| GET | `/api/tasks/:id/steps/:stepId/routing` | path `id`, `stepId` | Routing decision view | 404 task or decision not found |
| POST | `/api/tasks/:id/stage-agents/:stage` | path `id`, `stage`; body `agent`, a registered agent id, required | Updated task | 400 unregistered agent |
| DELETE | `/api/tasks/:id/stage-agents/:stage` | path `id`, `stage` | Updated task | 400 |
| POST | `/api/tasks/:id/stage-effort/:stage` | path `id`, `stage`; body `effort`, a valid effort level, required | Updated task | 400 invalid effort |
| DELETE | `/api/tasks/:id/stage-effort/:stage` | path `id`, `stage` | Updated task | 400 |
| POST | `/api/tasks/:id/stage-model-pools/:stage/preview` | path `id`, `stage`; body `poolId` required | Pin preview with warnings | 400 missing or invalid pool; 404 not found |
| POST | `/api/tasks/:id/stage-model-pools/:stage` | path `id`, `stage`; body `poolId` (registered pool), required; `acknowledgeWarnings` boolean, optional | Updated task | 400 invalid pool; 404 not found; 409 with `warnings` when confirmation is required and not acknowledged |
| DELETE | `/api/tasks/:id/stage-model-pools/:stage` | path `id`, `stage` | Updated task | 400 |
| POST | `/api/tasks/:id/pm-status` | path `id`; body `value` (`backlog`, `in_progress`, `in_review` or `done`), required | Updated task | 400 invalid value |
| POST | `/api/daemon/process-one` | none | Result of the processed task; empty body with 204 when no task is approved | 400 |

### Runs

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/runs/:runId/kill` | path `runId` (UUID) | `{ killed: true, aborted }` | 400 invalid run id |
| POST | `/api/runs/:runId/cancel` | path `runId` (UUID) | `{ killed: true, aborted }`. Same behaviour as kill | 400 invalid run id |
| POST | `/api/runs/:runId/input` | path `runId`; body `text` string, required | `{ delivered: true }` | 400 empty text; 404 run not found; 409 run not accepting input |
| POST | `/api/runs/clean` | query `projectId` string, optional | Result of the clean | 400 |
| GET | `/api/runs/:runId/events` | path `runId`; query `since` number, optional (default 0) | Server-Sent Events: replays events after `since`, then streams live (`event: run-event`) | 400 invalid run id |
| GET | `/api/runs/:runId/tail` | path `runId`; query `since` byte offset, optional (default 0) | `{ size, chunk, endOfFile }`. `chunk` holds the log text after `since`; `size` is 0 if no log exists. Rate limited (600/min) | 400; 404 read error |
| GET | `/api/runs/:runId/routing` | path `runId` | Routing decision view | 404 not found |
| GET | `/api/runs/:runId/artifacts/:fileName` | path `runId`, `fileName` | File contents, sent as a file response. Rate limited (60/min) | 400 path outside the runs directory |

### Memory

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/memory/pages` | query `projectId`, required | Array of memory pages | 400 missing projectId |
| POST | `/api/memory/pages` | body `projectId`, required, plus the memory page fields | 201 with the captured page | 400 missing projectId |
| POST | `/api/memory/index/rebuild` | body `projectId`, required; `targetPaths` string array, optional | Index rebuild result | 400 missing projectId |
| GET | `/api/memory/index/search` | query `projectId`, required; `q` string, optional | Index search hits | 400 missing projectId |
| GET | `/api/memory/pages/{slug}` | path `slug` (may contain `/`); query `projectId`, required | Memory page | 400 missing projectId or slug |
| DELETE | `/api/memory/pages/{slug}` | path `slug`; query `projectId`, required | 204 with no body | 400 missing projectId or slug; 404 page not found |

### Projects

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/projects` | none | Array of projects | 400 |
| POST | `/api/projects/pick-folder` | none | `{ path }`, or `{ canceled: true }` | 501 when no native picker exists |
| POST | `/api/projects` | body `repoPath` string, required; `name` string, optional | Created project. Quick starts and the quality gate are generated in the background | 400 missing repoPath |
| PATCH | `/api/projects/:id` | path `id`; body: any of `name`, `status` (`active` or `paused`), `repoPath` | Updated project. A changed repo path also repoints the project's tasks | 400; 404 not found |
| DELETE | `/api/projects/:id` | path `id` | `{ deleted: true }` | 400 |
| GET | `/api/projects/:id/intake/session` | path `id` | Intake session | 400 project not found |
| POST | `/api/projects/:id/intake/reset` | path `id` | Intake session | 400 project not found |
| POST | `/api/projects/:id/intake/confirm` | path `id` | 201 with `{ turn }` | 400 project not found |
| POST | `/api/projects/:id/intake/draft/dismiss` | path `id` | Intake session | 400 project not found |
| POST | `/api/projects/:id/intake/messages` | path `id`; body `body` string and `attachmentIds`, optional | 202 with `{ message, session }` | 400 project not found |
| POST | `/api/projects/:id/intake/queue/:itemId/retry` | path `id`, `itemId` | `{ session }` | 400 project not found |
| POST | `/api/projects/:id/jobs/:jobName/run` | path `id`, `jobName` | Job run result | 400 |
| POST | `/api/projects/:id/jobs/:jobName/run-mode` | path `id`, `jobName`; body `runMode`, optional (default `manual`) | Updated job | 400 |
| GET | `/api/projects/:id/quickstarts` | path `id` | Quick starts for the project | 400 project not found |
| POST | `/api/projects/:id/quickstarts/regenerate` | path `id` | Regenerated quick starts. Without a test runner, the response is the current state while generation runs | 400 project not found |
| GET | `/api/projects/:id/quality-gate` | path `id` | Quality-gate file: status, checks, rationale | 400 project not found |
| POST | `/api/projects/:id/quality-gate/regenerate` | path `id` | Regenerated quality gate, or the current state while generation runs | 400 project not found |
| POST | `/api/projects/:id/quality-gate/run` | path `id`; body `check` string, optional (one check; omit to run all) | Run summary: `outcome`, `pass`, `results`. A full run is saved as the last run | 400 project not found |
| PUT | `/api/projects/:id/quality-gate/checks` | path `id`; body `checks` array, required | Updated quality-gate file | 400 invalid checks, with `details`; 400 project not found |

### Proposals and runtime assets

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/proposals/:id/approve` | path `id` | Proposal record | 404 not a proposal |
| POST | `/api/proposals/:id/reject` | path `id` | Proposal record | 404 not a proposal |
| GET | `/api/runtime-assets` | none | `{ manifest, migration }` | 400 |
| POST | `/api/runtime-assets/migrate` | none | Migration result | 400 |
| GET | `/api/runtime-assets/:kind/:id/diff` | path `kind` (`workflow` or `skill`), `id` | Diff against the shipped asset | 400 unknown kind |
| POST | `/api/runtime-assets/:kind/:id/keep` | path `kind`, `id` | Updated asset state | 400 |
| POST | `/api/runtime-assets/:kind/:id/reset` | path `kind`, `id` | Updated asset state | 400 |

### Autonomy

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/autonomy/jobs/:id/run` | path `id` | Job run result | 400 |
| POST | `/api/autonomy/jobs/:id/run-mode` | path `id`; body `runMode`, optional (default `manual`) | Updated job | 400 |
| POST | `/api/autonomy/jobs/:id/status` | path `id`; body `status`, optional (default `paused`) | Updated job | 400 |

### Workflows

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/workflows` | none | Workflow summaries | 400 |
| GET | `/api/workflows/:id` | path `id` | Workflow definition | 404 unknown workflow |
| POST | `/api/workflows/sync` | none | `{ synced, workflows }` | 400 |
| POST | `/api/workflows/validate` | body: workflow definition | `{ valid: true, workflow }`, or 400 with `{ valid: false, error }` | 400 |
| POST | `/api/workflows/serialize` | body: workflow definition | `{ yaml }` | 400 |
| POST | `/api/workflows/parse` | body `yaml` string, required | `{ workflow }` | 400 |
| POST | `/api/workflows` | body: workflow definition with `id` | 201 with the saved workflow | 400 invalid; 409 id already exists |
| PUT | `/api/workflows/:id` | path `id`; body: workflow definition whose `id` equals the path | Saved workflow | 400 invalid or id mismatch; 404 unknown |
| DELETE | `/api/workflows/:id` | path `id` | 204 with no body. The default workflow cannot be deleted. Rate limited (60/min) | 400 default workflow; 404 unknown |

### Agent configuration

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/agent-config` | none | `{ config, usage, runtimeDiagnostics }`. Diagnostics are empty in test mode | 400 |
| POST | `/api/agent-config/probe` | body `toolId` string, optional (omit to probe all) | `{ runtimeDiagnostics }` | 404 unknown tool |
| PUT | `/api/agent-config/tools` | body: tool definition | `{ config }` | 400 |
| DELETE | `/api/agent-config/tools/:id` | path `id` | `{ config }` | 400 |
| PUT | `/api/agent-config/pools` | body: model pool definition | `{ config }` | 400 |
| DELETE | `/api/agent-config/pools/:id` | path `id` | `{ config }` | 400 |
| POST | `/api/agent-config/pools/bulk-enabled` | body `toolId` string and `enabled` boolean, both required | `{ config }` | 400 missing or invalid fields; 404 unknown tool |
| POST | `/api/agent-config/models/discover` | body `toolId`, required (`codex` or `cursor`) | `{ config, discovered }` | 400 unsupported tool; 404 unknown tool; 500 discovery failed |
| PUT | `/api/agent-config/profiles` | body: routing profile | `{ config }` | 400 |
| POST | `/api/agent-config/usage/refresh` | none | `{ usage }` | 400 |
| GET | `/api/agent-config/extensions` | none | `{ registry, tools }` | 400 |
| POST | `/api/agent-config/extensions/discover` | none | `{ registry, results }`. No discovery runs in test mode | 400 |
| PUT | `/api/agent-config/extensions` | body: extension definition | `{ registry }` | 400 |
| POST | `/api/agent-config/extensions/install` | body `toolId` and `source`, required; `confirmed` must be `true`; `marketplace`, `marketplaceSource`, optional | `{ install, registry, discovery }`. Runs the tool's plugin install command | 400 without confirmation or with unknown tool |
| DELETE | `/api/agent-config/extensions/:id` | path `id` | `{ registry }` | 400 |

### Terminal

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/terminal/sessions` | none | `{ sessions }` | 400 |
| GET | `/api/terminal/sessions/:id` | path `id` | Session record | 404 not found |
| POST | `/api/terminal/sessions` | body `kind` (`shell` or `agent`, default `shell`); for agents `toolId` required, `modelPoolId` optional; `taskId`, `cwd`, `label` optional; `cols`, `rows` numbers, optional | 201 with the session. 200 with the existing session when the task already has a live terminal | 400 agent has no interactive mode; 404 task or tool not found; 500 spawn failed |
| DELETE | `/api/terminal/sessions/:id` | path `id` | 204 with no body | 404 not found |

### Attachments

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/attachments` | body `filename` and `data` (base64), required; `mimeType` string, `source` (`intake` or `workflow`, default `workflow`), optional | 201 with the attachment record | 400 missing fields or empty data |
| GET | `/api/attachments/:id` | path `id` | File bytes with `Content-Disposition: attachment`. Rate limited (60/min) | 404 unknown or missing blob |

### Connectors

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/connectors/:providerId/connect` | path `providerId` (`github`, `gitlab` or `clickup`); body `method` (`token`, default, or `gh`); `token` string | Connection record | 400 unknown provider, or `gh` for a non-GitHub provider |
| PATCH | `/api/connectors/:connectionId` | path `connectionId`; body `config` object | Updated connection | 400 |
| DELETE | `/api/connectors/:connectionId` | path `connectionId` | 204 with no body | 404 not found |
| GET | `/api/connectors/:connectionId/resources` | path `connectionId`; query `refresh` (`1` or `true`), optional | Resource list | 400 |
| POST | `/api/connectors/:connectionId/import` | path `connectionId` | 201 with the created tasks | 400 |

### Intake

| Method | Path | Input | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/intake/session` | none | Intake session | 400 |
| POST | `/api/intake/reset` | none | Intake session | 400 |
| POST | `/api/intake/confirm` | none | 201 with `{ turn }` | 400 |
| POST | `/api/intake/draft/dismiss` | none | Intake session | 400 |
| POST | `/api/intake/messages` | none | Always refused: ticket intake requires a project | 409 |
