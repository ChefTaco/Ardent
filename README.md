# Ardent

Ardent is a headless TypeScript agent runtime. One process serves one
**profile**: a directory with a YAML config, a persona (`SOUL.md`,
`IDENTITY.md`), skills, and private SQLite state. Ardent runs model turns
against an OpenAI-compatible chat server (llama.cpp, vLLM, ...) or the Codex
App Server, calls typed tools, and keeps a durable journal of every task.

What you get:

- **Durable tasks** with idempotency keys, cancellation, deadlines, and a
  per-task event journal in SQLite. Interrupted work is marked `unknown`,
  never silently replayed.
- **Management API** (Hono, bearer-token protected) for tasks, sessions,
  config, identity, skills, peers, channels, and live event streams, including
  the reply text as the model writes it. The
  OpenAPI document is served at `/openapi.json` and pinned in
  [`openapi/ardent.json`](openapi/ardent.json).
- **A2A protocol 1.0** server and client over JSON-RPC, HTTP+JSON, and gRPC,
  with authenticated peers, push notifications, and bounded "team missions"
  that scope which tools a peer may reach.
- **Scheduled jobs** (cron with IANA timezones, or fixed intervals) with
  exactly-once window receipts.
- **Skills**: Markdown working methods the model can read on demand.
- **Context compaction** for long sessions, driven by a model policy file.
- **Optional integrations**: news research (SearXNG + Firecrawl), HiveMem
  long-term memory, Telegram and Mattermost chat channels, read-only Magnus
  Control tools, and Hermes Agent team-card compatibility. Each one is off
  until you configure it.
- **Plugins**: add tools, API routes, CLI commands, and job handlers from a
  separate npm package.

Context fitting and checkpoint compression use the pinned
`@hivemagnus/emberfold` library directly; the optional Emberfold HTTP service is
not required. Ardent retains authoritative SQLite history, transactional
publication, model-policy fences, task eligibility, and journal events. Existing
checkpoints stay readable by the previous runtime; richer portable metadata is
stored in an additive `emberfold_checkpoint_metadata` sidecar table. The initial
integration retains existing budgets and uses the general continuity profile.

For existing installations that must retain their runtime extensions, the node
manager offers [context-only adoption](https://github.com/ChefTaco/magnus/blob/main/docs/ARDENT_CONTEXT_ADOPTION.md).
It stages the pinned adapter and engine without replacing the runtime, runs
isolated provider acceptance, and verifies an actual old-runtime rollback.

## Install

Ardent needs Node.js 24.22.3+ or 26.13.1+. Its pinned `@photostructure/sqlite`
driver bundles SQLite 3.54.1 and stable Node-API binaries for supported x64/arm64
platforms. Existing profile databases keep their format and journal history.
Node.js 26 is recommended for its patched built-in libraries.

Version 3 replaces the low-level `TaskStore.db` driver surface with the application's
storage boundary. Code that used better-sqlite3-specific methods must migrate;
the management API, CLI and plugin hooks retain their existing contracts.

```bash
npm i -g @hivemagnus/ardent
ardent init --non-interactive            # creates ~/.ardent/profiles/assistant
ardent doctor                            # lists unresolved configuration
```

`init` copies the bundled `assistant` template, sets the profile timezone to
the host's zone, and writes a random management token to the profile's
`.env`. Use `--profile NAME` (or `--profile-path /abs/dir`) to create and
select other profiles, and `--api-port N` to choose the management port.
`ARDENT_HOME` overrides the `~/.ardent` root.

Point the profile at a model, then talk to it:

```bash
cat >> ~/.ardent/profiles/assistant/.env <<'EOF'
ARDENT_LLAMA_BASE_URL=http://127.0.0.1:8080/
ARDENT_LLAMA_MODEL=your-model-name
EOF
ardent chat                              # interactive session
ardent run --prompt "Summarize RFC 9110 in three bullets"
ardent mission submit --mission-file mission.json   # a team mission, see below
ardent gateway run                       # management API, A2A, channels, jobs
```

`ardent help` lists every command.

### Under Magnus and in the Hive suite

Each [Magnus](https://github.com/ChefTaco/magnus) release is built and tested
against one pinned Ardent version: Magnus 3.1.1 pins Ardent 3.1.3. Every Ardent
release is followed by a Magnus release that moves the pin, regenerates its
Ardent contract and updates the node agent; until then, managed nodes keep the
pinned version.

Magnus installs that pinned package on a node and creates profiles with its
**New Agent** workflow, which always enables HiveMem. In a
[Hive](https://github.com/ChefTaco/hive) suite installation, run
`./hive.sh ardent setup` after enrolling the host agent: it creates an
`assistant` profile through Magnus and tests a real model response. See Hive's
[Create an Ardent assistant](https://github.com/ChefTaco/hive/blob/main/deployment/FULL.md#create-an-ardent-assistant)
and Magnus's [Ardent guide](https://github.com/ChefTaco/magnus/blob/main/docs/ARDENT.md).
Ardent Project Studio and the UI reach those profiles only through Magnus.

### Native suite artifact

Build this repository's `Dockerfile` from the repository root, then select that
reviewed immutable image ID or digest in a [Magnus](https://github.com/ChefTaco/magnus)
checkout:

```bash
npm run build:native-agent -- --product ardent --image PINNED_IMAGE --output NEW_DIRECTORY
```

The archive includes the exact Node binary, the public Ardent package, locked
production dependencies and their licenses. It contains no inference runtime or
models. The descriptor supplies literal launch arguments, an exact version
preflight and a read-only acceptance command for Hive's signed release matrix.
Local export does not publish or certify an artifact.

Select an existing profile explicitly with `--profile-path` and keep credentials
in an owned, mode `0600` environment file selected with `--env-file`. The native
launcher loads that file before Node starts, including `NODE_EXTRA_CA_CERTS`
when a private CA is required. It never evaluates the file as shell code.
Profile initialization is a separate operator action and refuses an existing
profile. Provider sign-in remains explicit.

`ardent --env-file FILE --profile-path DIR acceptance` checks the running
gateway's authenticated status, exact version, profile, backend and dependency
readiness. It returns bounded JSON without credentials or upstream diagnostics.
The default target is the profile's loopback management listener; an optional
`ARDENT_ACCEPTANCE_URL` must be an HTTPS origin, with an optional protected
`ARDENT_ACCEPTANCE_CA_FILE`. Redirects and nonlocal cleartext are refused.
Acceptance executes no model generation or tools. Verify scoped inference,
memory, skills and channel workflows separately before enabling consumers.

## Configuration

`config.yaml` (schema 1) is validated strictly; unknown keys are rejected. A
string of the form `${NAME}` is resolved from the environment (the profile
`.env` is loaded automatically). Secrets are never written to the config,
only the *names* of the environment variables that hold them.

| Key | Default | Notes |
|---|---|---|
| `profile`, `name` | required | Profile ID and display name. |
| `product` | `Ardent` | Shown in the profile summary. |
| `timezone` | host zone, else `UTC` | IANA zone used for dates shown to the model. Job schedules carry their own zone. |
| `identity.soul_file`, `identity.identity_file` | `SOUL.md`, `IDENTITY.md` | Persona files in the profile. |
| `execution` | required | `backend: llamacpp \| codex`, step, tool-call, parallelism, and deadline limits. See [Tool scheduling](#tool-scheduling). |
| `providers.llamacpp` | required | `base_url`, `model`, `api_key_env`, `request_timeout_seconds`, optional `context_window_tokens`, `max_output_tokens`, `reasoning_effort`. |
| `providers.codex` | required | `command`, `model`, `auth_mode: chatgpt \| api_key` (default `chatgpt`); `approval_policy: never` and `sandbox: read-only` are fixed. |
| `memory` | `{ provider: none }` | See [HiveMem](#hivemem-memory). |
| `research` | disabled | `enabled`, `searxng_url`, `firecrawl_url`, `firecrawl_token_env`. Enables the `news_search`, `news_article`, `news_collect`, and `news_capabilities` tools. |
| `skills` | `directories: [skills]`, `enabled: []` | Only enabled skills are shown to the model. |
| `a2a` | disabled | See [A2A](#a2a). |
| `channels.telegram`, `channels.mattermost` | disabled | See [Chat channels](#chat-channels). |
| `integrations.magnus_control` | disabled | See [Magnus Control tools](#magnus-control-tools). |
| `artifacts.max_bytes` | `2097152` (2 MiB) | Largest artifact a task may store, up to 64 MiB. See [Team missions](#team-missions). |
| `plugins` | `[]` | See [Plugins](#plugins). |
| `api` | `127.0.0.1:9910`, `ARDENT_API_TOKEN` | Management listener and the env var holding its bearer token. A non-loopback host is refused; put a TLS proxy in front instead. |

`ardent config schema` prints the full JSON Schema, and `ardent config
validate` checks a profile without starting it.

### Tool scheduling

Task concurrency and tool concurrency are separate settings:

| Key | Default | Notes |
|---|---|---|
| `execution.max_parallel_tasks` | `3` | Tasks running at once, 1-16. The runtime runs at most 4. |
| `execution.max_parallel_tool_calls` | `4` | Tool calls from one model turn in flight at once, 1-16. |
| `execution.max_parallel_tools` | none | Deprecated. Despite its name it limits tasks. It is used only when `max_parallel_tasks` is absent, and `ardent config validate` and `ardent doctor` then report the notice `execution.max_parallel_tools is deprecated: it limits tasks; set max_parallel_tasks`. A notice never makes the profile unready. |

The llama.cpp and Codex backends dispatch tool calls through the same scheduler:

- A call is *parallel-eligible* when its tool is a `read` tool that does not
  declare `concurrency: 'serial'`, or any tool that declares
  `concurrency: 'parallel'`. Every other call, including an unknown tool and
  `team_ask_user`, is serial.
- Calls are admitted in the order the model emitted them (for Codex, the order
  the calls arrive). Consecutive parallel-eligible calls overlap, at most
  `max_parallel_tool_calls` at a time. A serial call is a barrier: it starts
  after every earlier call has settled, and later calls wait for it. A write
  therefore never overlaps anything unless its tool opts in.
- Each dispatch waits while the task is paused, checks `max_tool_calls` (for the
  whole task), journals `tool_attempt`, waits for team admission, runs plugin
  `beforeToolCall` hooks, invokes the tool, journals `tool_result` with the call
  `id`, and then runs `afterToolCall` hooks.
- llama.cpp receives the results in the order it emitted the calls, each bound
  to its call id. Codex binds each result to its own RPC request, and its
  follow-up turn lists results in completion order.
- On cancellation, calls that were not dispatched settle as
  `{ ok: false, code: 'CANCELLED', effect: 'none' }` and are journaled as
  `tool_not_dispatched` (with a `reason`). A call already started keeps its
  uncertainty, so a cancelled task with a started call is `unknown`, never
  `cancelled`. A call that would exceed `max_tool_calls` is not dispatched and
  fails the task.

Each tool receives `ctx.idempotencyKey`, `sha256("<task id>:<call id>")` in
hex, as the third `invoke` argument (`defineTool` handlers receive it as their
third argument). A tool may forward it to its service so that a repeated
dispatch of the same model call is harmless. A tool can also declare
`idempotent: true` (repeating it with identical arguments and key is safe) and a
`reconcile(input, ctx, signal)` hook that asks its service what happened to an
interrupted call. Execution recovery will use these; the runtime does not call
`reconcile` yet. Tools that declare none of these keep their existing
behaviour.

### HiveMem memory

Memory is off by default. To use a HiveMem server:

```yaml
memory:
  provider: hivemem
  base_url: ${HIVEMEM_API_URL}
  token_env: HIVEMEM_TOKEN
  agent_id: assistant
  workspace_id: ${HIVEMEM_WORKSPACE}
  default_scope: private
```

Direct conversations then get `hivemem_status`, `hivemem_search`,
`hivemem_browse`, and explicit write tools. Peers never read private memory; a
validated team mission may grant read access to one shared `project:<id>`
scope.

To rotate the HiveMem credential without a restart, write the new token into the
profile environment file (`.env`, or the `--env-file` the gateway started with)
and call `POST /api/v1/memory/credential/reload` with no body or `{}`. The
gateway re-reads only the `token_env` variable, checks that it is a well-formed
JWT, and uses it for every later HiveMem request; requests in flight finish
with the previous token. It answers `{"reloaded": true, "token_env": "...",
"changed": true|false}`, `409` when memory is not `hivemem`, and `422` (the old
token stays in use) when the new value is missing or malformed.

### Chat channels

```yaml
channels:
  telegram:
    enabled: true
    token_env: TELEGRAM_BOT_TOKEN
    allowed_user_ids: [123456789]     # only these users are answered
  mattermost:
    enabled: true
    base_url: ${MATTERMOST_URL}       # e.g. https://chat.example.com
    token_env: MATTERMOST_TOKEN
    allowed_user_ids: [user-id]
    require_mention: true
    reply_mode: thread                # thread | flat
    catchup:                          # optional; these are the defaults
      max_posts: 2000                 # 1-10000 posts from others per walk
      max_age_hours: 24               # older missed posts are skipped, not answered
```

Telegram uses long polling; Mattermost uses its v4 REST and WebSocket APIs.
Both support `/help`, `/new`, `/status`, `/jobs`, `/model`, `/stop`, `/tasks`,
and `/sources`. Each inbound message and outbound reply is journaled, so a
restart never sends the same reply twice.

**Mattermost catch-up.** Posts missed while Ardent was stopped or its
WebSocket was down are recovered from history. Ardent keeps a boundary per
channel (the newest post up to which everything older is settled). On start,
after every reconnect, and every 30 seconds, it walks back from the newest post
to that boundary in pages of 200 (`before=<post id>`), then handles the posts
oldest first. This works with Mattermost and ChatterMost alike.

| Key | Default | Meaning |
|---|---|---|
| `catchup.max_posts` | `2000` (at most `10000`) | Posts from others that one walk reads. The bot's own posts do not count, but a walk reads at most `2 × max_posts / 200` pages. |
| `catchup.max_age_hours` | `24` | A missed post older than this is claimed as `skipped_stale` and not answered. |

Every eligible post in the walk ends in exactly one of four ways:

- **Answered.** It goes through the normal channel path: an atomic claim, then the task, then the reply.
- **Already claimed.** A live event, an earlier walk or an earlier run claimed it. It is never answered again, so a reply whose outcome is unknown is never replayed.
- **Skipped as stale.** The claim is recorded with `disposition` `skipped_stale`.
- **Lost to a permanent gap.** The gap is recorded as a row with `walk_bound` when the walk reached its bound before the boundary, or `retention` when the server no longer holds the history (for example, the `before` pivot disappeared).

The boundary moves only past posts settled in order, so an interrupted walk
resumes where it stopped. A channel seen for the first time is seeded without
answering its history.

Replies that the server rate-limits (`429`) wait out `Retry-After` under the
`mattermost` retry policy (see [Retries](#retries)). `GET /api/v1/status` reports the latest walk of each channel under
`channels.mattermost.catchup`:

- `state`: `idle`, `catching_up`, `complete` or `gap`.
- Counters: `recovered`, `skipped_stale`, `already_claimed` and `pages`.
- Gaps: the gap count and `last_gap`.

### A2A

```yaml
a2a:
  enabled: true
  bindings: [jsonrpc, http-json, grpc]
  public_url: ${ARDENT_A2A_PUBLIC_URL}   # advertised origin, e.g. https://agent.example.com:9900
  listen_host: 127.0.0.1
  listen_port: 9900                      # gRPC listens on listen_port + 1
  peers_file: peers.yaml
  skill: { id: research, name: Research, description: Sourced answers, tags: [research] }
  hermes_compat: false
  rate_limit:                            # all optional; these are the defaults
    enabled: true
    ip_requests_per_minute: 600          # every HTTP request, before authentication
    ip_burst: 120
    peer_requests_per_minute: 300        # after authentication, per peer (also gRPC)
    peer_burst: 60
    max_concurrent_tasks_per_peer: 16    # queued and running tasks
    trusted_proxies: []                  # proxies whose X-Forwarded-For is believed
```

A limited request is answered with `429` and `Retry-After`. The client address
is the socket address unless the connecting address is listed in
`trusted_proxies` (addresses or CIDR ranges). Behind a reverse proxy, all clients
otherwise share the proxy's address and one bucket, so list the proxy there.
gRPC requests count against the peer limit and the task cap; the address limit
covers HTTP only. Limits are kept in memory, per process.

Peers are listed in `peers.yaml` with the environment variables holding their
inbound and outbound bearer tokens. An ordinary peer task can reach only the
public news tools. A peer that sends a validated team mission envelope gets
the tools its `resources` allow (`public:news`, `magnus:fleet`,
`magnus:node:<id>`, or `tool:<name>` for any registered tool) and must return
a structured, evidence-checked team result.

`hermes_compat: true` additionally serves the authenticated
`/.well-known/hermes-team-card.json` discovery document and accepts Hermes
Agent's slash-style JSON-RPC method aliases (`message/send`, `tasks/get`, ...).

`ardent a2a discover <peer>` and `ardent a2a call <peer> --prompt TEXT` talk
to configured peers from the command line.

### Magnus Control tools

Read-only fleet tools for a [Magnus](https://github.com/ChefTaco/magnus)
Control API (fleet inventory, readiness, node health, dependency impact,
anomalies, command status, and more). Enable them with
`integrations.magnus_control.enabled: true` or `ARDENT_MAGNUS_CONTROL_TOOLS=true`.
The base URL comes only from `integrations.magnus_control.base_url` (default
`${ARDENT_MAGNUS_API_URL}`) and the read token from the env var named by
`token_env` (default `ARDENT_MAGNUS_READ_TOKEN`). Bearer tokens are sent only
over HTTPS or to loopback.

### Scheduled jobs

Put job definitions in `jobs/active.json` inside the profile:

```json
{
  "schema_version": 1, "profile": "assistant", "revision": 1,
  "jobs": [{
    "id": "morning-news", "owner": "ardent", "enabled": true, "handler": "news.collect",
    "schedule": { "cron": "30 6 * * *", "timezone": "Europe/Berlin", "missed_window": "skip", "catch_up_minutes": 0 },
    "input": { "query": "open source AI agents", "max_articles": 3 },
    "delivery": { "kind": "none" },
    "policy": { "max_attempts": 2, "retry_backoff_seconds": 300 }
  }]
}
```

`ardent jobs definitions validate --source /abs/path.json` checks a file
before you install it; `ardent jobs definitions status` and
`GET /api/v1/jobs/definitions/status` report the installed revision and recent
windows. The built-in handler is `news.collect` (requires `research`); plugins
add more.

A window that asks to retry with `effect_status: "none"` waits
`retry_backoff_seconds · 2^(attempt-1)` with equal jitter (a random delay
between half and all of it), and only while the next attempt would start
before the job's next window is due; otherwise it ends `failed` with
`RETRY_DEADLINE`.

### Retries

Every retry site in Ardent names a policy in [`src/retry.ts`](src/retry.ts),
built on the shared `@hivemagnus/hive-common/retry` helpers:

| Site | Attempts | Backoff | Repeated when |
|---|---|---|---|
| llama.cpp completion and token count | 3 | 250 ms → 4 s, equal jitter; `Retry-After` (seconds or HTTP date) up to 10 s | transport error or 408/425/429/5xx before any response byte is read |
| A2A Agent Card, Hermes team card, `getTask`, `listTasks`, extended card | 3 | 500 ms → 5 s, equal jitter | transport error or 408/425/429/5xx over HTTP |
| A2A `SendMessage` | 3 | 500 ms → 5 s, equal jitter | as above, always with the same `messageId` |
| A2A push delivery | 3 | `Retry-After` clamped to 1–5 s | 408/425/429/5xx (the callback did not accept the event) |
| Telegram Bot API | 4 | Telegram's `retry_after`, capped at 60 s | 429 with `retry_after` |
| Mattermost/ChatterMost REST | 3 | `Retry-After` up to 60 s (1 s without one) | 429 only (the request was not processed) |
| Codex turns, tools with a possible effect | 1 | — | never |

Nothing is repeated once its effect is uncertain, after any response byte was
consumed (a stream that fails mid-way is not restarted), past the deadline
(`RETRY_DEADLINE`; for model calls the task deadline and the request timeout),
or when the response carries `x-hive-retry: exhausted` (the gateway already
retried). Cancelling during a backoff wait ends the call at once. Model
retries are journaled as `model_retry` task events
(`{ step, operation, attempt, reason, delay_ms }`); A2A outbound calls,
push deliveries and Telegram deliveries record `attempts` on their rows.

### Model policy

An optional, owner-only `$ARDENT_HOME/model-policy/active.json` selects the
Codex model and reasoning effort and configures context compaction for all
profiles under that home. [`model-policy.default.json`](model-policy.default.json)
is a starting point; compaction is disabled until you enable it.

### Live task streams

`GET /api/v1/tasks/{id}/stream` is a server-sent event stream. It sends:

| Event | Data | Notes |
|---|---|---|
| `task.event` | A journal event | The event `id` is the journal sequence. Resume with `Last-Event-ID` or `?after=` |
| `task.text` | `{step, text}`: the visible reply text of the current model step | Sent on connect and when a new step starts showing text |
| `task.delta` | `{step, text}`: text to append | |
| `task.done` | The finished task | Its `result` is the authoritative answer |

The stream closes after 60 seconds; reconnect to continue.

Live text works the same for every backend and caller:
- It holds only what a user would see. Structured output, such as tool or research JSON, is never streamed.
- It is not journaled and has no event id. A reconnect receives a `task.text` snapshot instead of a replay.
- Codex sends its answer as one piece when the turn completes.

`ardent chat` uses the same rule to print replies as they arrive.

### Team missions

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

`development_note` stores an append-only development record: the agent's own
note about how it works (`epistemic: agent_reported`).

### Pause, preview and development history

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

## Plugins

A plugin is an ES module whose default export (or named `plugin` export) is an
`ArdentPlugin` object, or an array of them:

```ts
import { definePlugin } from '@hivemagnus/ardent';
import { z } from 'zod';

export default definePlugin({
  name: 'weather',
  registerTools(ctx) {
    ctx.tools.register(ctx.defineTool({
      name: 'weather_now', description: 'Current weather for a city.',
      input: z.object({ city: z.string().min(1) }).strict(),
      output: z.object({ summary: z.string() }),
      effect: 'read', contexts: ['direct'], timeoutMs: 10_000,
      handler: async ({ city }, signal) => ({ summary: await lookUp(city, signal) }),
    }));
  },
  routes(app, ctx) {                       // served under /api/v1/plugins/weather/
    app.get('/health', c => c.json({ ok: true, profile: ctx.config.profile }));
  },
  cliCommands: {                           // ardent weather-check
    'weather-check': { description: 'Probe the provider', run: async ({ print }) => print({ ok: true }) },
  },
  jobHandlers: ctx => ({ /* 'weather.daily': JobHandler */ }),
  jobOwnership: ctx => async (job, now) => { /* throw to refuse a job window */ },
  peerTool: (tool, task, envelope) => false, // allow a peer to call one of your tools
  taskTools: ctx => [],                   // additions bound to the exact persisted task
  filterTool: (ctx, tool) => true,         // restrictive final filter
  drain: async (ctx, timeoutMs) => true,   // stop intake and await owned work
  close: ctx => {},                       // synchronous cleanup after a successful drain
});
```

Load it from config, as an npm package name (resolved from the profile
directory first, then from Ardent's own install), an absolute path, or a
`file://` URL:

```yaml
plugins: ['@example/ardent-weather', /opt/ardent/plugins/local.mjs]
```

Embedders that build the runtime themselves can call `registerPlugin()` before
loading plugins. Plugin tools join the profile's shared tool registry; a tool's
`contexts` decides whether direct, peer, or scheduled tasks may call it, and a
peer still needs an explicit mission grant (`tool:<name>`) or `peerTool`.
Plugin routes sit behind the same bearer-token check as the rest of the
management API.

A module may also export an asynchronous factory receiving `{ config, profileDir,
env }`. It returns a plugin or an array of plugins. This allows profile-specific
configuration and offline validation without constructing a runtime, claiming jobs,
or starting channel consumers. The CLI supplies the selected profile environment;
embedders can pass it as the third argument of `loadPlugins`.

Import supported extension primitives from `@hivemagnus/ardent/plugin-sdk` rather
than reaching into `dist`. This entry point includes the runtime, tool and job
contracts, profile/configuration helpers, provider clients, artifact and identity
helpers, and the application SQLite boundary (`SqliteDatabase`). Task additions retain their declared contexts and peer/mission grants. Preview
additions must be read-only. Restrictive filters apply to built-in and extension
tools; duplicate names cannot replace a tool silently. Stateful plugins must stop
intake and await their owned work in `drain`. A false or timed-out drain keeps the
journal open and ownership unsettled; `close` cannot bypass it. Cleanup runs in
reverse registration order, including partially initialized plugins.

Additional hooks support extensions that retain an existing workflow contract:

| Hook | Boundary |
| --- | --- |
| `systemPrompt` | Supplies trusted policy text; the full model input is still budgeted. |
| `allowMemory` | Can deny an admitted read; cannot grant a different scope. |
| `observeToolResult`, `beforeFinish`, `taskSettled` | Track actual task evidence, validate before success, and release task-local resources. |
| `teamEnvelope`, `admitTeamEnvelope` | Validate a legacy wire shape and apply extra admission restrictions. Identity, deadlines, parent reservations, constraints and resources remain core-validated. |
| `taskExecutor` | Runs one owned deterministic workflow. Attempts precede invocation in the journal; lost or unknown effects stay held across restart. Preview and mission execution cannot be replaced. |
| `inputImages` | Supplies at most five owned, digest-verified PNG/JPEG artifacts to a direct Codex task. Paths outside the selected profile's artifacts are rejected. |
| `teamEvidence` | Validates retained extension receipts. Artifacts require an exact mission grant and verified bytes; format-only citation aliases must target observed references. |
| `teamCard` | Describes private role capabilities without granting permissions or claiming backend readiness. |
| `prepareGateway`, `start` | Verify prior consumer ownership, then start background intake only in gateway mode. CLI inspection does not start consumers. |
| `channelAdapter` | Replaces one enabled built-in channel consumer. Multiple owners are refused. Intake and delivery receive separate abort signals. |
| `httpRoutes` | Adds explicit compatibility paths; overlapping core routes and authentication-boundary changes are refused. |

### Lifecycle hooks

Message and tool lifecycle hooks let one extension follow a channel message
from receipt to delivery, and a tool call from invocation to its result or
cancellation, without replacing a channel adapter. Every hook is optional and
may be asynchronous. Each one gets a frozen copy of what it observes, and each
must settle within 5 seconds.

| Hook | When | Permitted | On a throw, rejection or timeout |
| --- | --- | --- | --- |
| `messageReceived(ctx, message)` | A built-in Telegram or Mattermost consumer has claimed a new, authenticated message, before command or task handling | Observe | Recorded; handling continues |
| `messagePersisted(ctx, message, task)` | The message's task is accepted and bound to it, before it runs | Observe | Recorded; the task runs |
| `transformOutbound(ctx, delivery)` | A reply is recorded for delivery, before it is sent | Return `{ text }` (1 byte to 64 KiB, not blank) to replace the text; return nothing to keep it. Transformations chain. When the text changes, the task journal records `outbound_transformed` with the sent text | The **original** text is sent, discarding every transformation; recorded |
| `messageDelivered(ctx, delivery, outcome)` | The delivery is recorded `sent`, `failed` or `unknown` | Observe | Recorded |
| `beforeToolCall(ctx, call)` | After context scoping, argument validation, the `tool_attempt` journal entry and team admission, before the tool is invoked | Return `{ deny: { code, message } }` to deny; the result is `{ ok: false, code, message, effect: 'none' }` and the journal records `tool_denied_by_plugin`. Anything else is ignored | The call is denied (`TOOL_DENIED_BY_PLUGIN`); recorded |
| `afterToolCall(ctx, call, result)` | The result is journaled, successful or not | Observe | Recorded; the task continues |
| `toolCallCancelled(ctx, call, { dispatched, effect })` | On cancellation, for calls not yet dispatched (`dispatched: false`, `effect: 'none'`) and calls in flight (`dispatched: true`; `effect: 'unknown'` unless the tool is `read`). Runs before `taskSettled` | Clean up | Recorded |

`message` is `{ platform, account, update_id, channel_type, caller, session_key,
received_ms, execution? }` and carries no message text. `delivery` is
`{ delivery_id, task_id, platform, account, update_id, text, attempt }`.
`call` is `{ task_id, call_id, name, arguments, effect, idempotency_key,
execution? }` with the validated arguments. `ctx.execution` and `execution` are
attribution for the causal tree a task belongs to; they never grant access and
are absent until a caller supplies them.

Order: `before*` and `transform*` hooks run in plugin registration order, and
the first denial wins. Observers also run in registration order. Cleanup hooks
(`toolCallCancelled`, `taskSettled`, `drain`, `close`) run in reverse
registration order.

A failed hook is recorded as a `plugin_hook_failed` task event `{ plugin, hook }`.
For a message that never creates a task (a command such as `/help`), the
failure is recorded against the message's identity instead
(`runtime.store.pluginHookFailures(platform, account, update_id)`). An observer
failure never fails the task or the delivery. This includes
`observeToolResult`: a throwing `observeToolResult` is recorded and no longer
fails the task.

The hooks cannot widen authority. Context and mission scoping, plugin
`taskTools` and `filterTool`, and argument validation all happen before
`beforeToolCall`, which can only deny. A hook cannot change the arguments, the
result, the declared effect or the effect accounting, and `transformOutbound`
can change only the text of a reply that Ardent already decided to send.
Message hooks run for the built-in consumers; a plugin `channelAdapter` that
replaces one owns its own intake.

An envelope extension uses `mission.extensions[plugin.name]` and action names
`extension:<plugin-name>:<action>`. No extension is accepted without its configured
validator. A codec may retain an old wire action while translating it into its
own namespace; it cannot add a resource or substitute a core action grant.
Ardent retains the original wire envelope in its journal and revalidates it
when reading lifecycle controls or export receipts.

Normal plugin `routes` remain under `/api/v1/plugins/<name>/` and require the
management bearer token. `httpRoutes` declares each mount as `management` or
`independent`. Management aliases must remain under `/api/v1/` and inherit its
authentication. Independent device/webhook ingress must authenticate every
handler with its own credential and replay protection; it cannot use API,
health or A2A paths. All compatibility handlers receive a 1 MiB body bound and
share a bounded per-plugin rate bucket (600/minute, burst 120), applied before
handler authentication and parsing. Wildcard routes and middleware mounts are
refused so an extension cannot intercept unrelated core requests.

HTTP mounts may set `rateLimit: { perMinute, burst }` for their authentication
boundary. Defaults are 600 requests per minute and a burst of 120. Limits must be
positive integers no greater than 6000 and 1200 respectively. All mounts from one
plugin in the same boundary must agree; management and independent ingress retain
separate buckets. This capacity is trusted plugin policy and grants no authentication
or task authority. The one MiB body limit remains in force.

Offline job-validation contexts expose `runtimeAvailable: false`; their runtime
and tool registry getters throw. CLI extensions receive `rawArgs` for their own
option grammar, declare `valueOptions` to recognize values before the command, and can use `matches(invocation)` to select one subcommand while
leaving other core subcommands available. Plugin code has the profile owner's
process privileges: install only reviewed, pinned artifacts. These hooks preserve
authority boundaries between tasks; they do not sandbox an untrusted plugin.

Job owner labels other than `ardent` remain external references and never admit
work. A custom delivery kind requires its registered handler to validate the exact
descriptor. Existing definition bytes, revisions and receipts need not be rewritten
to rename an external scheduler. Historical channel labels also remain distinct;
a compatibility adapter must retain its original platform, account and receipt
identity instead of creating a second consumer under a renamed transport.

Extensions should
use `ctx.runtime.store` for the active journal and must not introduce a second
SQLite driver or rewrite another extension's state.

## Security model

- The model never gets a shell, deployment, or credential tool from Ardent
  itself. Retrieved text, memories, and peer messages are treated as data.
- Every tool declares its effect (`read`, `artifact-write`, `memory-write`,
  `external-write`). A cancelled task whose tool call may have had an effect
  is marked `unknown`, not `cancelled`, and is never retried automatically.
- Profile state, `.env`, and config are created owner-only (`0600`/`0700`).
- News URLs are restricted to public HTTP(S) addresses; private and loopback
  ranges are refused.

## Development

```bash
npm ci
npm run hooks:install   # privacy and secret checks on commit and push
npm run typecheck
npm run lint
npm test
npm run build
npm run openapi:check
npm run pack:check      # packs, installs, and smoke-tests the tarball
npm run verify          # every gate CI runs, in order
```

### Interoperability checks

Run `npm run interop` from this standalone checkout. The runner installs pinned
Python A2A SDKs and checks out an exact public Hermes revision in an ignored
cache; Python is used only for these tests. Both supported Node versions run
this suite in CI.

The suite exercises the real Python SDK and Hermes wire adapter in both
client/server directions. Team missions, lifecycle and child-budget transactions
use independent Python reference peers in `test/fixtures/team_reference.py`.
They implement the published Ardent wire contract; they do not load an external
Hermes team plugin or require a sibling Magnus checkout. The compatibility probe
explicitly enables `hermes_compat` and allows its combined functional workload
through the fixture's rate buckets. Default throttling remains covered by the
separate rate-limit tests.

See [AGENTS.md](AGENTS.md) for contributor guidance.

## License

Apache-2.0. The vendored A2A protocol definition in `protocol/` carries its own
license, [`protocol/LICENSE-A2A.txt`](protocol/LICENSE-A2A.txt).
