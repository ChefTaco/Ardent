# Team missions and artifacts

Team missions, artifact transfer v2 and renditions, pause, preview and development history. Part of the [Ardent](../README.md) documentation.

## Team missions

`POST /api/v1/missions` runs a team mission locally, for a coordinator such as
a project studio. It is accepted like a task (`202 {task_id, state}`) and
streams on `/api/v1/tasks/{id}/stream` like any task.

```json
{
  "objective": "Draft the opening scene",
  "mission": { "id": "scene-1", "revision": 1, "parent_task": null, "constraints": [],
    "allowed_actions": ["observe", "analyze", "create_artifact"],
    "resources": ["project:adventure", "tool:artifact_write", "tool:team_handoff"],
    "deadline": 1893456000, "acceptance_criteria": ["The scene is saved"], "expected_artifacts": [] },
  "context_items": [{ "title": "Brief", "mime": "text/markdown", "text": "..." }],
  "labels": { "project": "adventure" },
  "session_id": "<a session opened with context: mission>",
  "idempotency_key": "scene-1-turn-1"
}
```

- `mission` is the A2A team mission shape. The task runs in context `mission`,
  and its tools follow the peer mission rule: `resources` grant tools, never
  the model.
- The objective is at most 16,000 characters; `context_items` together at most
  64 KiB. Context items reach the model as tool data, so the context fitter can
  shorten them; the full text stays in the task journal.
- Memory reads use the agent's private scope plus one `project:<id>` grant.
  Missions never write memory.
- A session for a mission is opened with `POST /api/v1/sessions`
  `{key, context: "mission"}`.
- The task result is a `TeamResult` JSON document. A prose reply becomes a
  `partial` result with the reply as `summary`; a reply carrying a
  `team_result` is checked against the mission and the observed artifacts.

Mission tools are granted with `tool:<name>` resources. The coordination
tools only record a journal event; Ardent never acts on them itself:

| Tool | Journal event | Notes |
|---|---|---|
| `team_handoff {to_role, objective, deliverables?, note?}` | `team_handoff` | Asks the coordinator to give work to another role |
| `team_ask_user {question, options?}` | `team_ask_user` | Ends the turn; the result is `input_required` with a clarification |
| `team_propose_decision {title, statement, rationale?}` | `team_propose_decision` | A proposal; only the user decides |
| `artifact_write {name, mime, text \| base64 \| workspace_path, revises_sha256?}` | `artifact_registered` | Markdown, text, JSON, CSV, SVG, PNG, JPEG, WebP, PDF or DOCX, up to `artifacts.max_bytes`. `workspace_path` reads a file inside the profile's `workspace` |
| `document_render {source_markdown, format: pdf \| docx, name, revises_sha256?}` | `artifact_registered` | Markdown to PDF or DOCX, up to `artifacts.max_bytes`; see below |
| `development_note {kind, title, body, sources?}` | `development_note` | Also available in direct tasks; see below |

`document_render` reads GitHub-flavoured Markdown: headings, paragraphs, bold,
italic, strikethrough, inline code, links, bulleted, numbered and task lists,
block quotes, code blocks, tables and horizontal rules. It never fetches a URL
or reads a file. PDF output draws ` ```svg ` blocks as vector figures; images
keep only their alternative text. DOCX output is written with
[`@hivemagnus/canvas-word-codec`](https://www.npmjs.com/package/@hivemagnus/canvas-word-codec):

- Headings use Word's Heading 1-6 styles, so they appear in the navigation
  pane; links to `http(s)` URLs become hyperlinks and other link targets are
  kept as text after the label.
- Bulleted lists and numbered lists that start at 1 use Word numbering. Word
  numbering here has one level, so nested lists are indented, and a numbered
  list that starts elsewhere or has nested content gets its numbers as text.
- Tables keep their header row, column alignment and inline formatting; a
  table longer than 100 rows continues in another table.
- PNG and JPEG images given as `data:` URIs are embedded. Other images become
  an `[image: alt]` placeholder and ` ```svg ` figures a short note, since
  DOCX output does not embed vector figures.
- Raw HTML is kept as literal text. A document beyond the DOCX exchange
  limits (for example more than 100 table columns) fails with
  `DOCX_RENDER_FAILED` and no effect.

Every registered artifact has an immutable manifest (digest, size, media type,
revision, provenance and the artifact it supersedes). `revises_sha256` makes
a new artifact a revision of an earlier one. `GET /api/v1/tasks/{id}/artifacts`
lists a task's manifests and `GET /api/v1/artifacts/{sha256}/manifest` returns
the newest manifest for a digest; the bytes stay at `GET /api/v1/artifacts/{id}`.

## Artifact transfer v2 and renditions

Artifacts up to `artifacts.max_bytes` (at most 64 MiB) move between agents
without inline task payloads, with bounded memory: every path streams. A
profile advertises `urn:hive:artifact-transfer:2` on its Agent Card
(`capabilities.extensions`, params `{max_bytes, range: true, renditions: true}`)
and `capabilities.artifact_transfer: 2` in `GET /api/v1/status`.

Manifest 1.1 is a strict superset of 1.0. It may add `rendition` (`role`
`original | preview | model_input`, `of_sha256`, `purpose`, `transform {name,
version, params}`) and `provenance.execution` (`root`, `task`, `step`, attribution
only). It is as immutable as 1.0 and is shown only to v2 consumers: the existing
manifest routes and the v1 descriptor still return 1.0, and stored 1.0 records
are never rewritten.

| Route | Purpose |
| --- | --- |
| `GET /api/v1/artifacts/{sha256}/content` | The bytes with `Accept-Ranges: bytes`, `ETag: "<sha256>"`, `Repr-Digest: sha-256=:<base64>:`, `X-Content-SHA256`, the manifest media type and `Content-Disposition: attachment; filename="<name>"`. One `Range` returns `206`, an unsatisfiable one `416`; an `If-Range` other than the ETag returns the whole artifact. |
| `GET /api/v1/artifacts/{sha256}/renditions` | `{renditions: [{sha256, role, mime, size, purpose, width?, height?, has_alpha?}]}`, the original first, the same for the original or any rendition. Pick one with HiveCommon `selectRendition`; `download` always means the original. |
| `GET /api/v1/artifacts/{sha256}/manifest/v2` | The newest manifest as 1.1. |
| `POST /api/v1/artifacts/imports {peer_id, a2a_task_id, artifact_id, task_id?}` | `202 {import_id}`: pull an artifact a configured peer exported from one of its completed tasks. |
| `GET /api/v1/artifacts/imports[/{id}]` | `{state: queued \| transferring \| verifying \| completed \| failed, received_bytes, size, attempts, error?}` |

An import resolves the peer's descriptor, negotiates `min(peer max_bytes, local
max_bytes)`, and appends to `<profile>/artifacts/.partial/<import id>`, committing
`received_bytes` after an fsync every 4 MiB. After an interruption or restart it
re-hashes the retained bytes as a stream and asks for the rest with `Range` and
`If-Range`; the gateway resumes unfinished imports when it starts. Transport
failures are retried under the `artifact_transfer` policy (see [Retries](configuration.md#retries))
within the import's deadline; `attempts` counts runs and retries. The final
SHA-256 and size are verified: on `DIGEST_MISMATCH` the partial file is deleted,
nothing is registered and nothing is retried until an operator reissues the
import (`POST` again). The verified file is renamed into the content store (an
existing digest is kept) and registered with a manifest 1.1 whose lineage adds
the peer hop. Without `task_id`, the import records its own completed task.
`ardent artifact import --peer <id> --task <a2a task> --artifact <id>` runs one
from the command line and `ardent artifact imports` lists them.

A team export to a peer is limited by `artifacts.max_bytes`. Each export emits a
`Team artifact export v2` A2A artifact with one data part of media type
`application/vnd.hive.artifact-transfer.v2+json` carrying `{manifest_1_1,
content_path, renditions_path, size, sha256}`. Up to 2 MiB, the unchanged v1 text
descriptor (`Team artifact export`) is still emitted; above it, a v1 consumer gets
an explicit `TRANSFER_REQUIRES_V2` result that names the capability, and an
importer facing a peer without the URN fails the same way. On the A2A listener,
`/team/artifacts/{id}` serves the v1 full response without `Range` (verified as
it streams) and gains `Range` and the headers above; `/team/artifacts/{id}/manifest`
returns the 1.1 manifest and `/team/artifacts/{id}/renditions` the exported forms
with their export IDs. Renditions of an exported original are exported with it.

Plugins reach the same primitives through `ctx.runtime` (and types from
`@hivemagnus/ardent/plugin-sdk`):

- `ctx.runtime.artifacts.putStream(readable, {name, mediaType, expectedSha256?,
  expectedSize?, maxBytes?, inspect?, signal?})` stores a stream (temporary file,
  incremental SHA-256, size bound, fsync, rename) and returns the `Artifact`;
  `openRead(sha256, {start?, end?}, {verify?})` returns `{stream, size, sha256,
  start, end}`; `stat(sha256)` returns `{size}` or undefined.
- `ctx.runtime.artifactManifests.registerStream({taskId, name, mime, stream,
  source, expectedSha256?, expectedSize?, revisesSha256?, ttlSeconds?, execution?})`
  stores and registers an original with a manifest 1.1, checking its content as it
  streams.
- `ctx.runtime.artifactManifests.registerRendition({originalSha256, role: preview |
  model_input, purpose, transform, mime, bytes | stream, name?, width?, height?,
  has_alpha?, producer?})` registers a separate rendition artifact linked to its
  original; the original is never changed. `renditions(sha256)` lists the forms
  and `manifestV2(sha256)` returns the 1.1 record.

`development_note` stores an append-only development record: the agent's own
note about how it works (`epistemic: agent_reported`).

## Pause, preview and development history

**Pause and resume.** `POST /api/v1/tasks/{id}/pause` holds a queued or running
task: a queued task does not start (later tasks run instead), and a running
task stops at its next step boundary, before a model call, before a tool call
is journaled, or before it settles. The journal records `pause_requested`,
`paused` (with the boundary) and `resumed`. Both routes are idempotent, and the
deadline keeps running while a task is paused. `POST /api/v1/tasks/{id}/resume`
releases it. Locally, `ardent tasks pause <id>` holds a queued task and
`ardent tasks resume <id>` releases and runs it.

**Preview.** `POST /api/v1/preview/tasks` `{prompt, overrides: {soul?,
identity?, skills_enabled?, model?}, session_id?}` runs one task in context
`preview` with unsaved changes. A preview gets the read-only direct tools, no
mission tools and no memory tools. It never writes memory, development
records, identity or configuration, and any artifact it produces expires after
24 hours. It streams like any task; a session for it is opened with
`context: "preview"`. `ardent preview --prompt TEXT [--soul-file FILE]
[--identity-file FILE] [--skills a,b | --no-skills] [--model NAME]` does the
same locally.

**Development history.** `GET /api/v1/development?after=&limit=&kind=` returns
the agent's development in one portable record shape, oldest first, with a
`next` cursor:

```json
{"id": "dev_...", "agent_ref": "assistant", "kind": "self_understanding", "title": "...", "body": "...",
 "author": "agent", "epistemic": "agent_reported", "before_sha256": null, "after_sha256": null,
 "sources": [{"kind": "task", "ref": "..."}], "created_at": "2026-11-08T12:00:00.000Z"}
```

It merges:
- the agent's `development_note` records (`agent_reported`);
- operator notes from `POST /api/v1/development` (`operator_reported`);
- skill selection changes, with the configuration revisions before and after (`observed`);
- soul and identity edits from the retained identity history (`observed`);
- research method reflections (`observed`).

`agent_ref` is the profile name. `ardent development list [--after CURSOR]
[--limit N] [--kind KIND]` prints the same pages.
