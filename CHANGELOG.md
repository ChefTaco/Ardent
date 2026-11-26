# Changelog

## Unreleased

### Upgrade notes

- The management API accepts only `Authorization: Bearer <token>`; a bare token without the scheme is now refused with 401 (the scheme is case-insensitive). A2A peer authentication parses the header the same way. Magnus, HiveXUI, ArdentStudio and `@hivemagnus/ardent-client` already send the scheme.
- Management request bodies are limited to 1 MiB (`413 BODY_TOO_LARGE`), as plugin `httpRoutes` already were; plugin `routes` under `/api/v1/plugins/<name>/` now have the same limit.
- An error's HTTP status now comes from its type, not its message. Some answers change: an internal error whose message happened to contain words such as "missing", "invalid" or "timeout" is a `500 INTERNAL_ERROR` (it was 400 or 503); a peer that is not configured is `404` (it was 500); a fenced or draining profile is `503 NOT_ACCEPTING_WORK` (it was 500); a validation message without those words, a session opened for another context and a duplicate peer ID are `400` (they were 500); a HiveMem URL that is not valid is `503` (it was 400). Plugin route errors without a type keep the old classification.
- `GET /api/v1/providers` reports `codex.auth_mode: not_selected` for a llama.cpp profile instead of starting a Codex App Server on every call; pass `?probe=codex` for the previous answer.
- `execution.max_parallel_tasks` (and the deprecated `max_parallel_tools`) is no longer capped at 4: a profile that sets 5 to 16 now runs that many tasks at once. Set 4 to keep the previous concurrency.
- The Agent Card `provider` is `{ organization: 'Ardent', url: 'https://github.com/ChefTaco/Ardent' }` unless `a2a.provider` sets it; it was always Magnus. A Magnus-managed profile that should name Magnus sets `a2a.provider`.

### Added

- `a2a.provider: { organization, url }` sets the Agent Card provider.
- `@hivemagnus/ardent-client` covers missions (`missions.submit`), previews (`previews.submit`), development history (`development.list`, `development.note`) and task pages (`tasks.page`, and filters on `tasks.list`), directly and through Magnus's `mission-submit`, `preview-submit` and `development-note` actions and `development` read. Task filters raise `UnsupportedCapabilityError` against an Ardent before 3.4, or through a Magnus that does not advertise `task_filters`, instead of returning unfiltered tasks.
- `@hivemagnus/ardent-client/openapi` exports the generated OpenAPI `paths`/`operations`/`components` types and `ARDENT_ROUTES`, a route manifest marking each management operation as `read` or `action` (with `auth` and `stream`), plus `matchArdentRoute(method, path)`. `npm run openapi:write` generates it and `openapi:check` fails on drift.
- `GET /api/v1/tasks` pages through every task: it returns `next`, a cursor to pass as `after`, and filters by `state` (comma-separated), `context`, `caller`, `since` and `until` (epoch milliseconds or ISO 8601). Without the new parameters it answers as before, plus `next`. `TaskStore.page()` backs it (new index `tasks_created_id`).
- `TaskStore.onAppend(taskId, listener)` notifies after each journal event the store appends.

### Changed

- The task SSE stream (`/api/v1/tasks/{id}/stream`) wakes on journal appends instead of polling SQLite every 250 ms per stream; a one-second poll still picks up events written by another process. An idle stream sends a `: keepalive` comment every 15 seconds, so proxies keep it open.
- Typed management API errors (`src/errors.ts`, HiveCommon `HiveError`): every core route maps statuses explicitly; dependency probes (providers, channels, peers, HiveMem search) answer `503 DEPENDENCY_UNAVAILABLE` with the probe's message. `@hivemagnus/ardent/plugin-sdk` exports `HiveError`, `ErrorCode`, `invalidRequest`, `notFound`, `conflict`, `dependencyUnavailable` and `notAcceptingWork` for plugin routes; `RecoveryConflictError` is a `HiveError` (409).
- `/health/live` and `/health/ready` use `@hivemagnus/hive-common/health`: their bodies add `service`, `version`, `time` and (readiness) `checks`, the shape of the other suite services. Readiness keeps `problems` and its `degraded` status on 503.
- Readiness and `GET /api/v1/providers` share one Codex account probe, cached for 30 seconds.

### Fixed

- `execution.max_parallel_tasks` is honoured as validated (1-16); the runtime silently ran at most 4.

## 3.3.0 - 2026-11-26

### Upgrade notes

- No configuration or schema change is needed. Backup and upgrade tools that keep their own list of Ardent journal tables can switch to `@hivemagnus/ardent/journal` (`inspectJournalFile`) or `ardent journal status --json` to decide whether a stopped profile is idle; Magnus adopts it in its next release.

### Added

- **Journal quiescence is owned by Ardent.** `@hivemagnus/ardent/journal` exports `JOURNAL_TABLES` / `journalPolicy()`, a versioned (`JOURNAL_POLICY_VERSION` 1), JSON-serializable classification of every SQLite table and its idle rule, and `inspectJournal(path)` / `inspectJournalFile(path)`, which return `{ idle, active, unknown, unsupported, tables }` for a profile journal without loading a runtime, store or plugin. `ardent journal status [--db FILE] [--json]` prints the same result read-only (it inspects a digest-verified private copy of the database and its WAL, and needs no valid configuration); `ardent journal policy` prints the classification. Backup and upgrade tools such as Magnus's node agent can use it instead of their own table list. A test fails when a `CREATE TABLE` in `src/` has no classification. See "Journal quiescence" in the README.
- `GET /api/v1/status` returns `task_states` (tasks per state) and `jobs.last_tick_error` (`{ message, at }` or `null`); `GET /api/v1/jobs/definitions/status` and `ardent jobs definitions status` return `last_tick_error`, and `ardent doctor` returns `last_job_tick_error`. Job engine tick failures were recorded but never reported.
- The management API logs an unhandled error (a 500) as a JSON line on stderr with the method and path, using `@hivemagnus/hive-common/log` redaction; the gateway also logs job engine tick failures. Callers still see only "Internal request error".

### Fixed

- `POST /api/v1/providers/test` accepts a Codex account that matches `providers.codex.auth_mode`, as readiness does. It rejected every profile configured with `auth_mode: api_key`.
- `GET /api/v1/status` `tasks` is the number of tasks in the journal; it never exceeded 10.
- The gateway's unsettled-shutdown message describes execution recovery instead of saying interrupted tasks become `unknown`.
- The npm package no longer ships a compiled test file that imports `vitest`; `npm run pack:check` rejects test files.
- The README no longer names a fixed Magnus-to-Ardent pin; it points to Magnus's CHANGELOG and `ardent:latest:check`.

### Changed

- `ws` 8.23.0 and `@hono/node-server` 2.1.11 (lockfile and minimum ranges), so the native image built with `npm ci` carries them.

## 3.2.1 - 2026-11-24

### Fixed

- `@hivemagnus/ardent-client`: `viaMagnus` now reaches Magnus through a Hive console. Give `apiBase`, the URL that stands for Magnus's `/api/v1` (a console's `https://<console>/api/magnus`), instead of `baseUrl`; the client then adds no `/api/v1`. `baseUrl` (the Magnus origin) behaves as before, and giving both or neither is refused. The CLI example takes `--magnus-api`.

## 3.2.0 - 2026-11-24

**Interrupted tasks now resume by default.** After a crash or restart, a task that was `running` continues under the same id from its last completed model or tool boundary instead of becoming `unknown`; a task with an unsettled effect is held `unknown` with an actionable recovery status. Set `execution.recovery.enabled: false` for the previous behaviour.

### Added

- **`@hivemagnus/ardent-client`**, the supported remote client (npm workspace `client/`, released with Ardent at the same version from the same tag; see `client/README.md`). It runs in Node.js 24+ and modern browsers with `@hivemagnus/hive-common` as its only dependency, and reaches a profile directly (`direct({ baseUrl, getToken })`) or through the Magnus Control API (`viaMagnus({ baseUrl, nodeId, profile, getToken })`). It covers task submit, get, list, events, cancel, pause and resume; `tasks.follow`, which reconnects the task stream from its cursor across the 60-second rotation and dropped connections and returns the final task; sessions; recovery `get`/`decide`; lineage; artifact lists, manifests, renditions and imports; resumable `Range` downloads verified against the artifact's SHA-256; and `capabilities()`. Errors are `HiveError` subclasses (`UnauthorizedError`, `NotFoundError`, `ConflictError`, `UnsupportedCapabilityError`, `TransportError`, `DigestMismatchError`); `getToken()` is asked again once after a 401; every call takes an `AbortSignal`. Through Magnus, routes Magnus does not allow yet (recovery, lineage, artifact content, renditions and imports before Magnus 3.3.0) raise `UnsupportedCapabilityError`. The A2A protocol is out of scope.
- `npm run release:version -- X.Y.Z` bumps the runtime and the client together; `npm run version:check` (in `verify`) fails when they differ. The publish workflow publishes the runtime and then the client from one `vX.Y.Z` tag, and `npm run pack:check` packs, installs, imports, type-checks and browser-bundles the client.

- Execution recovery (see README "Execution recovery"). Startup recovery plans every interrupted task before queued work is admitted: resumed (it stays `running`, reusing completed model replies and settled tool results, and re-dispatching unsettled reads and idempotent calls under the same idempotency key), reconciled through the tool's `reconcile` hook, or held as `unknown` with a recovery status (`awaiting_decision` or `unsupported`) and a reason code. A write is never repeated merely because execution resumed; the original deadline is never extended; cancellation, pause, tools, mission scope, memory grants and ownership are re-derived and survive recovery.
- SQLite (additive): `execution_state`, `tool_invocations` and `task_recovery`, written in the same transaction as the journal event of each boundary (model reply, before a tool invocation, after its result); and `artifact_manifests.idempotency_key`.
- API (additive): an optional `recovery` object on task responses; `GET /api/v1/tasks/{id}/recovery`; `POST /api/v1/tasks/{id}/recovery` with `mark_applied`, `mark_not_applied`, `retry_with_new_deadline` and `abandon`, which continue the work as a linked continuation task (idempotency key `recovery:<id>:<attempt>`, execution source `continuation`); `GET /api/v1/status` reports `recovery` counts.
- Recovered channel tasks reply: Telegram and Mattermost answer an update whose task was resumed, settled or continued after a restart, once, through the record-before-send path (`ChannelCore.deliverRecovered` / `watchRecovered`; the reply target is the new `channel_inbound.reply_target_json` column). A channel delivery is now claimed atomically (`TaskStore.claimDelivery`), so an update that already has a delivery is never sent again.
- A2A peers see recovered tasks: a resumed peer task reports `completed` with its answer; a held one stays `working` with `ardentRecovery` metadata until an operator decision, and then follows the continuation's outcome; an unsupported or abandoned one reports `failed` ("Execution outcome is unknown"). Final states and their push notifications are published at most once (new `a2a_recovery_publications` table). `A2ASurface.recovery` and `ArdentRuntime.onTaskSettled` are new.
- Configuration: `execution.recovery.enabled` (default `true`), `execution.recovery_max_new_deadline_seconds` (default `deadline_seconds`) and `providers.codex.durable_threads` (default `true`).
- Codex: task threads are durable and their thread and turn ids are recorded. Recovery resumes a thread only when `thread/read` verifies every tool call in it and `codex-protocol.lock.json` verifies thread recovery for the installed CLI (`thread_resume_verified`, `thread_read_items_verified`, both `false` for the observed CLI); otherwise it restarts a task that never dispatched an effectful tool and holds the rest (`CODEX_THREAD_NOT_VERIFIABLE`).
- Journal events: `execution_resumed`, `recovery_planned`, `recovery_held`, `tool_reconciled`, `recovery_continued`, `recovery_continuation_of`, `recovery_decided`, `execution_suspended` and `codex_thread_unverified`. `model_result` carries `calls` (id, name, compacted arguments).
- `ArdentRuntime.resumeRecovered()`, `recoveryFor()` and `decideRecovery()`; `TaskStore.recover()` also returns `resumed` and `held` task ids; `TaskStore.accept` takes `suppressSessionUserMessage`.

- Tool scheduling: llama.cpp and Codex dispatch tool calls through one scheduler. Independent `read` calls from one model turn overlap up to `execution.max_parallel_tool_calls` (default 4); any other call is a barrier, unless its tool declares `concurrency: 'parallel'`. llama.cpp receives results in the order it emitted the calls. Calls that are not dispatched when a task is cancelled settle with effect `none` and are journaled as `tool_not_dispatched`; calls already started keep their uncertainty.
- `execution.max_parallel_tasks` sets task concurrency (the runtime still runs at most 4).
- Tool contract (additive): `idempotent`, `concurrency`, a `reconcile` hook (used by execution recovery) and a third `invoke` argument `{ idempotencyKey, execution? }`, where `idempotencyKey` is `sha256("<task id>:<call id>")`. `defineTool` handlers receive it as their third argument. `ToolRegistry` gains `get`, `prepare` and `invokePrepared`; `call` accepts the context as an optional fifth argument.
- Plugin lifecycle hooks: `messageReceived`, `messagePersisted`, `transformOutbound`, `messageDelivered`, `beforeToolCall` (deny only), `afterToolCall` and `toolCallCancelled`. `ArdentTaskPluginContext` gains an optional `execution`. See "Lifecycle hooks" in the README.
- Journal events: `tool_not_dispatched`, `tool_denied_by_plugin`, `plugin_hook_failed` and `outbound_transformed`.
- Mattermost and ChatterMost catch-up. After an outage, the adapter walks channel history back to a durable per-channel boundary, `{ last_ms, last_post_id }`. It reads pages of 200 posts with `before=<post id>` and handles the missed posts oldest first.
  - Walks run on start, after every WebSocket reconnect, and every 30 seconds.
  - The walk is bounded by the new `channels.mattermost.catchup.max_posts` setting (default 2000, at most 10000).
  - Posts older than `catchup.max_age_hours` (default 24) are claimed as `skipped_stale` and not answered.
  - History beyond the bound, or removed by retention, is recorded once as a permanent gap.
  - Progress for each channel is reported in `GET /api/v1/status` under `channels.mattermost.catchup`.
  - Claims stay atomic, so a live event that is also in the backlog is answered once. A post that was already claimed, including one whose reply outcome is unknown, is never answered again.
- SQLite: a new `channel_inbound.disposition` column (`admitted` by default, or `skipped_stale`), and new `channel_catchup_gaps` and `channel_catchup_runs` tables. Skipped-stale claims are not counted as unbound inbound work when admission is fenced.
- Artifact transfer v2 (`urn:hive:artifact-transfer:2`): resumable pulls of peer artifacts up to `artifacts.max_bytes` over HTTP Range with If-Range, whole-file SHA-256 verification and bounded memory. `POST /api/v1/artifacts/imports`, `GET /api/v1/artifacts/imports[/{id}]` and `ardent artifact import | imports` record progress in the new `artifact_transfers` table and a partial file under `artifacts/.partial`; a restart resumes from the committed bytes, and a digest mismatch discards them with `DIGEST_MISMATCH`. Older peers keep the v1 path up to 2 MiB and fail with `TRANSFER_REQUIRES_V2` above it.
- `GET /api/v1/artifacts/{sha256}/content` with Range (206/416), `ETag`, `Repr-Digest`, `X-Content-SHA256`, the manifest media type and file name; `GET /api/v1/artifacts/{sha256}/renditions`; `GET /api/v1/artifacts/{sha256}/manifest/v2`. `GET /api/v1/status` reports `capabilities.artifact_transfer: 2`, and the Agent Card advertises the URN with `{max_bytes, range, renditions}`.
- Manifest 1.1, a strict superset of 1.0 with optional `rendition` and `provenance.execution`, shown only to v2 consumers. Renditions are separate artifacts linked to their original in the new immutable `artifact_renditions` table.
- Team exports are limited by `artifacts.max_bytes` and emit a v2 descriptor data part beside the unchanged v1 text descriptor (up to 2 MiB) or an explicit `TRANSFER_REQUIRES_V2` result (above it). `/team/artifacts/{id}` gains Range and the digest headers; `/team/artifacts/{id}/manifest` and `/renditions` are new.
- Plugin SDK: `ArtifactStore.putStream`, `openRead`, `stat`, `verify` and `adoptFile`; `ArtifactManifests.registerStream`, `registerRendition`, `renditions` and `manifestV2`; the manifest 1.1 schemas and `ArtifactTransfers`.
- Execution ancestry (execution context v1 from `@hivemagnus/hive-common/execution`; attribution only). Every new task has an execution context in the new `task_execution` table: supplied by the caller (optional `execution` on `POST /api/v1/tasks`, `/api/v1/missions` and `/api/v1/preview/tasks`, else the `x-hive-execution` header, or A2A `metadata.hiveExecution`) or minted as a root. Its `self` is `hx1:ardent:<instance>:task:<id>`. A malformed context is treated as absent, never rejected. See README "Execution ancestry".
- `ARDENT_INSTANCE_REF`: the instance in qualified references (default `local.<profile>`). An invalid value stops the runtime and is listed by `runtimeProblems()`.
- llama.cpp requests carry `x-request-id` (new per request), `traceparent` (a child span of the task trace) and `x-hive-execution` (self `hx1:ardent:<instance>:attempt:<task>/<step>/<n>`). `model_started` events journal `attempt`, `ref`, `request_id` and `traceparent`; the llama.cpp research repair call journals its own `model_started` with `repair: true`.
- `ArdentA2AClient.send`, `sendWithReceipt` and `sendStreaming` take an optional `{ execution }` and send it as `metadata.hiveExecution`. Team child claims store the child's context next to the grant (`a2a_team_child_claims.execution_json`), outside the grant digest.
- Tools get the task's context as `ctx.execution`, and plugins as `execution` on `ArdentTaskPluginContext` and tool calls. `TaskStore.executionFor(taskId)` and `ArdentRuntime.executionFor(taskId)` return it.
- API (additive): task responses include an optional `execution`, the `accepted` event detail includes `execution`, and `GET /api/v1/tasks/{id}/lineage` returns the task's execution, parent, local children and continuations, model attempts with request ids, tool calls and artifacts.
- `tool_attempt` events record the tool's `effect`.
- Artifact provenance: manifests a task registers (`register`, `registerStream`, imports) record manifest 1.1 `provenance.execution` `{root, task, step?}` from the task's context; `ArtifactManifests.executionProvenance(taskId)` returns it. 1.0 views are unchanged, and tasks without a context still store 1.0. An artifact import task takes the producer task as its parent.

### Changed

- The generated OpenAPI types moved from `test/generated/ardent-openapi.ts` to `client/src/generated.ts`, where `npm run openapi:write` writes them and `npm run openapi:check` fails on drift. Ardent's own tests use the client; the `openapi-fetch` test helper and devDependency are gone.
- `TaskStore.recover()` no longer marks every interrupted task `unknown`; it applies the execution recovery rules. A cancelled task whose only tool calls were denied by a plugin, settled without effect, or never dispatched is now `cancelled` rather than `unknown`.
- `artifact_write` and `document_render` are idempotent: a repeat under the same idempotency key returns the same registration. They and the mission coordination tools and `development_note` reconcile interrupted calls against their local rows.
- One retry policy model (`src/retry.ts`, on `@hivemagnus/hive-common/retry`) covers llama.cpp, the A2A client, A2A push delivery, Telegram and scheduled jobs. See README "Retries".
- llama.cpp: completions and token counts make up to 3 attempts (250 ms → 4 s with jitter), honour `Retry-After` as seconds or an HTTP date up to 10 s, stop at the task deadline, never repeat after `x-hive-retry: exhausted`, and journal each retry as a `model_retry` event. They used to make 2 attempts with a 200 ms wait or a numeric `Retry-After` capped at 2 s.
- A2A client: card fetches and task reads, and `SendMessage` with the same `messageId`, are repeated on transport errors and 429/5xx. `a2a_outbound_calls.attempts` records the send attempts.
- A2A push: a callback answering 5xx is repeated like a 429. `a2a_push_deliveries.attempts` records the attempts.
- Telegram: `channel_deliveries.attempts` records the Bot API requests a delivery made.
- Jobs: retry backoff has equal jitter, and a retry is not scheduled past the job's next window (`RETRY_DEADLINE`).
- `LlamaCppBackend.complete` and `countInputTokens` take an optional trailing options object: `requestHeaders`, `deadlineMs` and `onRetry`.
- `tool_result` journal events from Codex tasks now carry the call `id`, as llama.cpp events already did, and Codex `backend_event` tool results carry it too.
- Codex tasks now wait for an operator pause before journaling a tool attempt, as llama.cpp tasks do. A paused Codex call that is cancelled is no longer counted as attempted.
- The tool-call limit is checked when a call is dispatched, for both backends. A Codex call over the limit is refused by the shared scheduler instead of on arrival.
- A plugin `observeToolResult` that throws is recorded as `plugin_hook_failed` and no longer fails the task (llama.cpp) or rejects the run (Codex).
- The bundled profile template uses `max_parallel_tasks` and `max_parallel_tool_calls`.
- Mattermost: the channel cursor is now `mattermost:<bot>:<channel>:last`, stored as JSON. A 3.1 `…:last_ms` cursor is read and upgraded in place, and is still written so that a rollback keeps working. An existing `…:reconcile_gap` record is moved into `channel_catchup_gaps` once.
- Mattermost: a live WebSocket post no longer moves the channel cursor past posts that are still missing.
- Mattermost: a request answered with `429` is repeated under a new `mattermost` retry policy (3 attempts, `Retry-After` up to 60 s). A burst of catch-up replies used to lose every reply past the server's rate limit.
- `GET /api/v1/artifacts/{id}` keeps its octet-stream response but streams it, verifying the digest as it goes. Team exports and extension evidence hash artifacts as streams instead of reading them whole.
- `/api/v1/tasks/{id}/artifacts` lists originals only; a task's renditions are listed with their original.

### Deprecated

- `execution.max_parallel_tools`. It limited tasks, not tools. It is still used when `max_parallel_tasks` is absent, and `runtimeProblems()` (`ardent config validate`, `ardent doctor`) then lists a `notice:` entry. `/health/ready` ignores notices.

### Removed

- The unused buffered `TeamArtifacts.fetchHermes` downloader, replaced by `ArtifactTransfers`.

## 3.1.4 - 2026-11-17

### Changed

- Update `@hono/node-server` to 2.1.6 and raise the minimum accepted version to `^2.1.6`, so installs no longer resolve the older 2.1.5.

## 3.1.3 - 2026-11-13

### Fixed

- Mattermost: a post longer than 16,000 characters is cut to that length. It used to be rejected on every reconciliation that still listed it, which stopped intake for the other channels and, after ten failed reconnects, ended the gateway.
- Mattermost: `@name:`, `@name;` and `(@name)` count as mentions, and a longer username such as `@name.helper` no longer does. A socket whose authentication is refused is closed.
- Telegram: a document that Telegram refuses to hand out (expired or unavailable) is passed on as metadata only. The failed lookup used to make every poll refetch the same update, so no later message was read.
- llama.cpp: a response stream that Ardent stops reading (for example after a malformed event) is cancelled, so the server does not keep generating into it.
- Artifacts: two tasks storing identical bytes in the same millisecond no longer collide on the temporary file.

## 3.1.2 - 2026-11-11

### Security

- Require patched Node.js 24.22.3 or 26.13.1 for supported runtime lines and update container and CI pins.
- Upgrade Hono to 4.13.18 to include the tiny-chunk request-body memory exhaustion fix (GHSA-39q9-qp46-w8xg).
- Remove unused package managers and their vulnerable bundled dependencies from the native-export image. The Node binary and application packages retain their existing paths.

## 3.1.1 - 2026-11-11

- Allow trusted extensions to declare bounded HTTP ingress capacity for chunked workflows. Management and independent ingress use separate buckets, and conflicting mounts fail before registration. Body limits, reserved routes and authentication remain enforced.

## 3.1.0 - 2026-11-11

- Add profile-specific asynchronous plugin factories, a supported plugin SDK, task-bound tool additions and restrictive tool filters, and drain/cleanup hooks that keep unresolved services and journals held.
- Preserve SQLite BLOB reads as Buffers for existing binary validators and retained upload receipts.
- Add validated wire extensions, retained workflow evidence and exports, owner-bound channel adapters and independently authenticated compatibility ingress. Deterministic extension execution journals attempts and holds unknown effects without replay.
- Separate background consumer startup from inspection, retain selected CLI environments and raw arguments, and protect offline discovery with exclusive ownership.
- Preserve historical inbound transport labels and external scheduler owner labels. Custom delivery descriptors require explicit handler validation; existing definitions and receipts are retained.

## 3.0.0 - 2026-11-10

### Changed

- Replace better-sqlite3 with pinned Node-API SQLite 3.54.1. Reject affected or unverifiable embedded versions independently of npm/image scanner coverage. Preserve profile files, transactional journals, rollback and backups.
- The low-level `TaskStore.db` type now exposes the application storage boundary; callers of driver-specific methods need to migrate. The management API, CLI and plugin hooks remain compatible.
- Check the real installed native engine, legacy-file preservation, read-only access, FTS5 transactions and atomic existing-file opens during acceptance.

## 2.3.1 - 2026-11-10

### Changed

- Use the released canvas Word codec 1.1.0 while preserving the established DOCX API.

### Fixed

- Make the A2A interoperability suite self-contained with independent transactional
  team reference peers, explicit Hermes compatibility and graceful fixture cleanup.
  Run all five scenarios in CI on both supported Node versions.

## 2.3.0 - 2026-11-08

### Added

- `document_render` with `format: "docx"` now writes a real DOCX artifact through
  `@hivemagnus/canvas-word-codec` instead of failing with `DOCX_UNAVAILABLE`. A new Markdown mapper
  (GFM via `marked`) turns headings, paragraphs, bold, italic, strikethrough, inline code, links,
  nested bulleted, numbered and task lists, block quotes, code blocks, tables and horizontal rules
  into the codec's Word exchange document. PNG and JPEG `data:` URI images are embedded; other images
  and ` ```svg ` figures become visible placeholders. Nothing is fetched or read from disk. A
  document beyond the exchange format's limits fails with `DOCX_RENDER_FAILED` and no effect; the
  artifact is still bounded by `artifacts.max_bytes`.

## 2.2.1 - 2026-11-08

### Fixed

- Context maintenance no longer imports the task context enum from `store.js`. Magnus adopts newer
  context maintenance onto an installed older runtime, whose `store.js` has no such export, so
  adoption failed to load in 2.2.0. A test now keeps the overlaid modules to base exports that every
  supported release provides.

## 2.2.0 - 2026-11-08

### Added

- `POST /api/v1/memory/credential/reload` (`reloadMemoryCredential`): re-reads only the
  `memory.token_env` variable from the profile environment file the gateway started from (`.env`
  or the protected `--env-file`), checks that it is a well-formed JWT, and swaps it into the
  gateway's shared environment so every later HiveMem request uses it without a restart. Answers
  `{reloaded, token_env, changed}`, `409` when memory is not `hivemem`, `422` when the credential
  is missing or malformed (the previous one stays in use). The token is never returned.
- Live reply streaming on `GET /api/v1/tasks/{id}/stream`. While a task runs, `task.text` and
  `task.delta` events carry the visible text of the current model step as the model writes it,
  for every task and backend. The text is not journaled and has no event id; reconnecting clients
  receive a `task.text` snapshot. Structured output is never streamed. `ardent chat` and the API
  share one filter for this.
- Team missions: `POST /api/v1/missions` accepts a `TeamMission` with an objective, up to 64 KiB
  of context items, labels and an idempotency key as a task in the new `mission` context. Tools
  follow the peer mission rule (`mission.resources`); memory reads use the private scope plus one
  `project:<id>` grant. The task result is a validated `TeamResult`. Sessions can be opened in
  the `mission` context (`POST /api/v1/sessions` `context`).
- Mission tools, each granted by a `tool:<name>` resource: `team_handoff`, `team_ask_user` (ends
  the turn as `input_required`), `team_propose_decision`, `artifact_write`, `document_render`
  (Markdown to PDF; DOCX reports that it is unavailable in this build) and `development_note`
  (also in direct tasks). Each records a journal event.
- Artifact manifests with revisions and supersession, `GET /api/v1/tasks/{id}/artifacts` and
  `GET /api/v1/artifacts/{sha256}/manifest`, a media-type allowlist, and the
  `artifacts.max_bytes` setting (default 2 MiB, at most 64 MiB).
- An append-only `development_records` table for the agent's development notes.
- `POST /api/v1/tasks/{id}/pause` and `/resume`: hold any queued or running task at its next step
  boundary, with `pause_requested`, `paused` and `resumed` journal events. Both are idempotent.
- Preview tasks: `POST /api/v1/preview/tasks` runs a prompt with unsaved soul, identity, skill
  selection or model overrides in the new `preview` context. Previews have read-only tools, never
  write memory, development records, identity or configuration, and their artifacts expire after
  24 hours.
- Development history: `GET /api/v1/development` merges development notes, operator notes
  (`POST /api/v1/development`), skill changes, identity edits and method reflections into one
  cursor-paginated record shape.
- CLI: `ardent mission submit`, `ardent preview`, `ardent development list`, and
  `ardent tasks pause` (`tasks resume` also releases a paused task).

### Fixed

- After `artifact_write` or `document_render` runs, large file content (text, base64 or Markdown
  over 8 KiB) is replaced in the model history and in `tool_attempt` journal events by a note with
  its size, digest and stored artifact reference. A multi-megabyte artifact no longer overflows the
  next model step's context or fills every task event stream and event page.

## 2.1.2 - 2026-11-07

The first release published from this repository.

### Repository

- Ardent now lives in its own repository, extracted from the Magnus monorepo
  (`packages/ardent` at commit `084a3292f4b459fe74c91af7e06b37d2aeb2774e`, the 2.1.1 release;
  see `provenance.json`). The package name, version, runtime code and published file set are
  unchanged; package metadata now points to this repository.
- Standalone build, lint, test, OpenAPI and package checks, a CI matrix on Node.js 24.22.1 and
  26.13.0, and a tag-triggered npm publication workflow with provenance through trusted
  publishing behind the protected `npm-publish` environment.
- The typed management client used by the tests is generated in this repository
  (`test/generated/ardent-openapi.ts`); Magnus generates its own from the published package.

### Maintenance

- Pin the installed `@a2a-js/sdk@1.3.0` (tag commit `29417a5`) in `protocol/lock.json`; the
  dependency moved from 1.2.1 without a lock update, so `npm run protocol:check` failed. The
  release adds database-backed stores only, and the interop results are the same on 1.2.1 and
  1.3.0. `npm run verify` now runs `protocol:check`.
- Mark the Python interop fixtures as detectable so CodeQL analyzes them.

## 2.1.1 and earlier

Released from the Magnus monorepo. See the
[Magnus changelog](https://github.com/ChefTaco/magnus/blob/main/CHANGELOG.md) for their notes.
