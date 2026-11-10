# Changelog

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
