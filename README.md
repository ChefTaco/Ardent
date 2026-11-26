# Ardent

Ardent is a headless TypeScript agent runtime. One process serves one
**profile**: a directory with a YAML config, a persona (`SOUL.md`,
`IDENTITY.md`), skills, and private SQLite state. Ardent runs model turns
against an OpenAI-compatible chat server (llama.cpp, vLLM, ...) or the Codex
App Server, calls typed tools, and keeps a durable journal of every task.

What you get:

- **Durable tasks** with idempotency keys, cancellation, deadlines, and a
  per-task event journal in SQLite. Interrupted work resumes from its last
  verified step after a restart; an operation whose effect is uncertain is
  held for a decision, never silently replayed (see
  [Execution recovery](#execution-recovery)).
- **Management API** (Hono, bearer-token protected) for tasks, sessions,
  config, identity, skills, peers, channels, and live event streams, including
  the reply text as the model writes it. The
  OpenAPI document is served at `/openapi.json` and pinned in
  [`openapi/ardent.json`](openapi/ardent.json).
- **Remote client** [`@hivemagnus/ardent-client`](client/README.md), released
  with Ardent, for Node.js and browsers: submit and follow tasks across stream
  reconnects, drive recovery decisions, read lineage, and download artifacts
  with resumable, digest-verified transfers, directly or through Magnus.
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
against one pinned Ardent version; Magnus's CHANGELOG names it, and
`npm run ardent:latest:check` in a Magnus checkout fails while that pin is older
than the latest Ardent release. Every Ardent release is followed by a Magnus
release that moves the pin, regenerates its Ardent contract and updates the
node agent; until then, managed nodes keep the pinned version.

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

### Journal quiescence

Backup, snapshot and upgrade tools need to know whether a stopped profile's
SQLite journal (`state/ardent.sqlite`) still holds work. Ardent owns that
answer, because it owns the schema; a tool should ask Ardent instead of keeping
its own list of tables.

```bash
ardent --profile-path DIR journal status --json   # or: journal status --db FILE
ardent journal policy                             # the table classification
```

`journal status` is read-only and needs neither a valid configuration nor
plugins. It copies the database and its WAL to a private temporary directory,
verifies the copy by digest, and inspects it there, so committed but
uncheckpointed work in the WAL is counted and no byte of the profile changes.
It fails if the files change during inspection, which means a gateway is
writing. It prints:

```json
{ "ardent_version": "3.3.0", "profile": "assistant", "policy_version": 1,
  "idle": true, "active": 0, "unknown": 0, "unsupported": 0,
  "tables": [{ "name": "tasks", "kind": "state", "active": 0, "unknown": 0, "unsupported": 0 }] }
```

| Count | Meaning |
|---|---|
| `active` | Work a gateway start would run, resume or send: queued or running tasks, deliveries and job windows, dispatched tool calls, recovery ready to resume, pending artifact imports, unbound A2A receipts, unsettled team-child claims. |
| `unknown` | Work whose outcome is uncertain and needs reconciliation or an operator decision (`unknown` tasks, deliveries and job windows, `failed_unknown` tool calls, recovery `awaiting_decision` or `unsupported`). |
| `unsupported` | Anything this Ardent version does not recognize: a table it does not classify, a virtual table, a missing or unexpected `state`/`status` column, an unrecognized state value, an empty file. The closed admission fence also counts here, because a temporary snapshot must never clear it. Tables with problems list them in `problems`. |

`idle` is true only when all three are zero. It describes the journal, not
whether a gateway is running: check that the service is stopped separately.
An integrity or foreign-key check failure is an error, not a count.

The same inspector is a library entry point that loads no runtime, store,
plugin or job handler:

```ts
import { inspectJournal, inspectJournalFile, journalPolicy, JOURNAL_POLICY_VERSION } from '@hivemagnus/ardent/journal';

const status = await inspectJournal('/path/to/profile/state/ardent.sqlite'); // private copy, as the CLI does
const staged = inspectJournalFile('/private/copy/ardent.sqlite');             // a copy you already own
```

`journalPolicy()` (and `JOURNAL_TABLES`) classifies every table as `state`
(with its `column` and its `active`, `uncertain` and `terminal` values),
`passive`, `ledger` or `special` (with a rule described in `description`).
`policy_version` changes only when the format or the counting rules change;
adding a table or a state value does not change it. A release that adds a table
classifies it in the same change (a test fails otherwise), so inspect a journal
with the Ardent version that wrote it or a newer one. An older Ardent reports a
newer table as `unsupported` rather than guessing.

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
| `execution.recovery.enabled` | `true` | Resume tasks interrupted by a crash or restart. `false` holds them as `unknown`, as before. See [Execution recovery](#execution-recovery). |
| `execution.recovery_max_new_deadline_seconds` | `deadline_seconds` | Longest deadline an operator may give `retry_with_new_deadline`, 1-86400. |
| `providers.llamacpp` | required | `base_url`, `model`, `api_key_env`, `request_timeout_seconds`, optional `context_window_tokens`, `max_output_tokens`, `reasoning_effort`. |
| `providers.codex` | required | `command`, `model`, `auth_mode: chatgpt \| api_key` (default `chatgpt`), `durable_threads` (default `true`: task threads are not ephemeral and their ids are recorded for recovery); `approval_policy: never` and `sandbox: read-only` are fixed. |
| `memory` | `{ provider: none }` | See [HiveMem](#hivemem-memory). |
| `research` | disabled | `enabled`, `searxng_url`, `firecrawl_url`, `firecrawl_token_env`. Enables the `news_search`, `news_article`, `news_collect`, and `news_capabilities` tools. |
| `skills` | `directories: [skills]`, `enabled: []` | Only enabled skills are shown to the model. |
| `a2a` | disabled | See [A2A](#a2a). |
| `channels.telegram`, `channels.mattermost` | disabled | See [Chat channels](#chat-channels). |
| `integrations.magnus_control` | disabled | See [Magnus Control tools](#magnus-control-tools). |
| `artifacts.max_bytes` | `2097152` (2 MiB) | Largest artifact a task may store, export to a peer or import, up to 64 MiB. See [Artifact transfer v2](#artifact-transfer-v2-and-renditions). |
| `plugins` | `[]` | See [Plugins](#plugins). |
| `api` | `127.0.0.1:9910`, `ARDENT_API_TOKEN` | Management listener and the env var holding its bearer token. A non-loopback host is refused; put a TLS proxy in front instead. |

`ardent config schema` prints the full JSON Schema, and `ardent config
validate` checks a profile without starting it.

A few settings come from the environment rather than `config.yaml`:

| Variable | Default | Notes |
|---|---|---|
| `ARDENT_HOME` | `~/.ardent` | Root of the profiles directory and the shared model policy. |
| `ARDENT_API_TOKEN` | — | Management API bearer token (the name is `api.token_env`). |
| `ARDENT_INSTANCE_REF` | `local.<profile>` | The instance part of this runtime's qualified execution references (`hx1:ardent:<instance>:...`). Magnus sets `<node id>.<profile>`. 1 to 96 characters of `A-Z a-z 0-9 . _ -`; any other value stops the runtime from starting and is listed by `ardent config validate`. See [Execution ancestry](#execution-ancestry). |

### Tool scheduling

Task concurrency and tool concurrency are separate settings:

| Key | Default | Notes |
|---|---|---|
| `execution.max_parallel_tasks` | `3` | Tasks running at once, 1-16. |
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
  uncertainty, so a cancelled task with a started call that may have had an
  effect (not a `read`, and not settled without effect, for example denied by a
  plugin) is `unknown`, never `cancelled`. A call that would exceed
  `max_tool_calls` is not dispatched and fails the task.

Each tool receives `ctx.idempotencyKey`, `sha256("<task id>:<call id>")` in
hex, as the third `invoke` argument (`defineTool` handlers receive it as their
third argument). A tool may forward it to its service so that a repeated
dispatch of the same model call is harmless. A tool can also declare
`idempotent: true` (repeating it with identical arguments and key is safe) and a
`reconcile(input, ctx, signal)` hook that asks its service what happened to an
interrupted call. [Execution recovery](#execution-recovery) re-dispatches an
interrupted idempotent call under the same key and asks `reconcile` before it
resumes a task; a tool that declares neither is held for an operator when one of
its calls is interrupted. `artifact_write` and `document_render` are idempotent
(a repeat under the same key returns the same registration) and reconcile from
their manifest row; `team_handoff`, `team_ask_user`, `team_propose_decision` and
`development_note` reconcile against their local journal rows. HiveMem writes
and `news_collect` declare neither, so they are held.

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
  provider: { organization: Example Org, url: https://agents.example.com }   # Agent Card provider; default Ardent
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
| Artifact transfer pull (import) | 5 | 500 ms → 8 s, equal jitter; `Retry-After` up to 30 s | transport error, a dropped response or 408/425/429/5xx; each attempt resumes from the retained bytes with `Range` and `If-Range` |
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

### Management API

The management API listens on loopback (`api.port`) and serves its OpenAPI
document at `/openapi.json` (pinned in `openapi/ardent.json`). Every
`/api/v1/` route needs `Authorization: Bearer <token>` with the value of the
variable `api.token_env` names; the scheme is case-insensitive, and a bare
token without it is refused. Request bodies are limited to 1 MiB (`413
BODY_TOO_LARGE`).

Errors use the suite envelope `{ "error": { "code", "message" } }`. The status
comes from the error's type, never from its message:

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | The body is not JSON or fails validation, or a value is not allowed |
| 401 | `UNAUTHORIZED` | No valid bearer token |
| 404 | `NOT_FOUND` | The task, session, skill, peer, import or history entry does not exist |
| 409 | `CONFLICT` | A revision or idempotency-key conflict, an edit in progress, a finished task, a recovery decision that is not valid now |
| 413 | `BODY_TOO_LARGE` | The body is over 1 MiB |
| 503 | `DEPENDENCY_UNAVAILABLE` | A provider, channel, peer or HiveMem probe failed, or the dependency is not configured |
| 503 | `NOT_ACCEPTING_WORK` | The gateway is draining for shutdown, or its admission is fenced for a rollback |
| 500 | `INTERNAL_ERROR` | Anything else; the message is always "Internal request error" and the gateway logs the cause |

Plugins throw `HiveError`s (`invalidRequest`, `notFound`, `conflict`,
`dependencyUnavailable` from `@hivemagnus/ardent/plugin-sdk`) to choose a
status. A plugin route error without a type is still classified by its message,
as before 3.4, so existing plugins answer as they did.

`GET /api/v1/tasks` lists tasks newest first, `limit` (1-100, default 50) at a
time, with `next`, a cursor to pass as `after` for the following page (`null`
on the last one). Filters combine: `state` (comma-separated, for example
`queued,running`), `context` (`direct`, `peer`, `scheduled`, `mission`,
`preview`), `caller` (exact, for example `management`), and `since` / `until`
(creation time, epoch milliseconds or ISO 8601; `until` is exclusive).

`/health/live` and `/health/ready` need no token and answer with the HiveCommon
health bodies (`status`, `service`, `version`, `time`, and for readiness
`checks`). Readiness also lists `problems`, and its status stays `degraded` when
it answers 503. It probes the selected backend only once the configuration is
complete. `GET /api/v1/providers` starts the Codex App Server only for a Codex
profile (`?probe=codex` asks a llama.cpp profile too; `auth_mode` is
`not_selected` otherwise); readiness and `/providers` share one Codex account
probe for 30 seconds.

### Operational logs

`ardent gateway run` writes JSON lines to stderr (stdout stays the CLI's
output) through `@hivemagnus/hive-common/log`, which redacts secrets.
`LOG_LEVEL` (`trace` … `fatal`, or `silent`; default `info`) sets the minimum
level. Every line has `time`, `level`, `msg`, `service: "ardent"` and
`profile`; management API lines add the request's `requestId` and `traceId`
(an inbound `x-request-id` and `traceparent` are kept, and `x-request-id` is
echoed on every response). The gateway logs:

| Message | Level | Fields |
|---|---|---|
| `Task settled` | `info`, `warn` when `failed` or `unknown` | `task_id`, `state`, `caller`, `context`, `backend`, `duration_ms`, `request_id`, `trace_id`, `error` |
| `Unhandled management API error` | `error` | `method`, `path`, `err` (the caller sees only "Internal request error") |
| `Plugin hook failed`, `Plugin denied a tool call` | `warn` | `plugin`, `hook` or `detail`, `task_id` |
| `Telegram update failed`, `Telegram poll failed; retrying`, `Telegram polling stopped` | `warn` / `error` | `account`, `update_id`, `failures`, `err` |
| `Mattermost post failed`, `Mattermost connection failed; reconnecting`, `Mattermost connection stopped after 10 failures` | `warn` / `error` | `post_id`, `channel_id`, `failures`, `err` |
| `A2A push delivery failed` | `warn` | `task_id`, `delivery_id`, `attempts`, `http_status`, `err` |
| `Job window retry`, `Job window failed`, `Job window unknown` | `info` / `warn` | `job_id`, `window_key`, `attempt` |
| `Job engine tick failed` | `error` | `err` |

A runtime embedded elsewhere is silent unless its host sets `runtime.logger`.

### Live task streams

`GET /api/v1/tasks/{id}/stream` is a server-sent event stream. It sends:

| Event | Data | Notes |
|---|---|---|
| `task.event` | A journal event | The event `id` is the journal sequence. Resume with `Last-Event-ID` or `?after=` |
| `task.text` | `{step, text}`: the visible reply text of the current model step | Sent on connect and when a new step starts showing text |
| `task.delta` | `{step, text}`: text to append | |
| `task.done` | The finished task | Its `result` is the authoritative answer |

The stream wakes as soon as the gateway journals an event for the task (events
another process writes arrive within a second), sends a `: keepalive` comment
when it has been idle for 15 seconds, and closes after 60 seconds; reconnect to
continue.
[`@hivemagnus/ardent-client`](client/README.md) does this for you
(`tasks.follow`).

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

### Artifact transfer v2 and renditions

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
failures are retried under the `artifact_transfer` policy (see [Retries](#retries))
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

### Execution recovery

After a crash or restart, every task that was `running` is evaluated before any
queued work starts. **A write is never repeated merely because execution
resumed**: an unknown effect needs reconciliation, never a retry. Each task is:

- **resumed under the same id**: it stays `running`, continues at the next
  unfinished model step, and reuses completed model replies and settled tool
  results;
- **reconciled first**: an interrupted tool call whose tool has a `reconcile`
  hook is asked what happened before the task continues; or
- **held** as `unknown` (still terminal) with a recovery status and an
  actionable reason, waiting for an operator decision or marked unsupported.

`TaskState` does not change. Tasks carry an optional `recovery` object (task
`GET` and list, and `GET /api/v1/tasks/{id}/recovery`), so older clients see
`running → completed` for a resumed task and `unknown` for a held one:

```json
{"status": "awaiting_decision", "attempt": 1,
 "reason": {"code": "UNSETTLED_EXTERNAL_WRITE", "message": "A tool call with a possible external effect was dispatched ..."},
 "checkpoint": {"step": 0, "completed_calls": 1,
   "pending_calls": [{"call_id": "call-1", "tool": "news_collect", "effect": "artifact-write", "dispatched_at": "2026-11-23T12:00:00.000Z", "reconcilable": false}]},
 "actions": ["mark_applied", "mark_not_applied", "retry_with_new_deadline", "abandon"]}
```

`status` is `ready` or `reconciling` (resuming), `resumed` (running again),
`awaiting_decision`, `unsupported`, or `resolved` (settled at startup, or
decided). `actions` lists only the decisions valid now. `GET /api/v1/status`
reports `recovery: { ready, reconciling, awaiting_decision, unsupported }`.

**How a task is planned.** Rules apply in order:

| Condition | Outcome | `reason.code` |
|---|---|---|
| Cancellation was requested | `cancelled`, or held when an effect is uncertain | `CANCELLED_DURING_OUTAGE` / `CANCELLED_WITH_UNSETTLED_EFFECT` |
| The deadline passed while stopped | `failed`, or held when an effect is uncertain; never extended | `DEADLINE_ELAPSED_DURING_OUTAGE` |
| `execution.recovery.enabled: false` | held, unsupported | `RECOVERY_DISABLED` |
| An extension `taskExecutor` with a possible effect ran, or a preview task | held, unsupported | `EXTENSION_EXECUTION_NOT_RESUMABLE` / `PREVIEW_NOT_RESUMABLE` |
| Codex | see the backend matrix | `CODEX_*` |
| llama.cpp, no checkpoint, no effectful tool dispatched | `ready`: restart from the beginning | `RESTART_NO_EFFECT` |
| llama.cpp, no checkpoint, an effectful tool dispatched (for example, from before this release) | held, unsupported | `NO_EXECUTION_CHECKPOINT` |
| A checkpoint fails its digest | held, unsupported | `CHECKPOINT_INVALID` |
| Every dispatched call settled, or the unsettled ones are reads or idempotent | `ready`: resume at the next step; unsettled reads and idempotent calls are dispatched again under the same idempotency key | `RESUME_FROM_CHECKPOINT` |
| An unsettled call whose tool can reconcile | `reconciling`: `applied` settles it with the service's result; `not_applied` tells the model it was not applied (it is not retried); `unknown` holds the task | `RECONCILE_INTERRUPTED_CALL` / `RECONCILIATION_INCONCLUSIVE` |
| Any other unsettled call with a possible effect | held, awaiting a decision | `UNSETTLED_EXTERNAL_WRITE` |

A call is *uncertain* when it was dispatched without a recorded outcome and is
not a `read`, or settled with an unknown effect. A call a plugin denied, that
settled without effect, or that was never dispatched leaves nothing uncertain.
Until the gateway knows a task's tools (plugins load after the journal opens),
a call that needs that check reports `reconciling` with `TOOL_CHECK_PENDING`;
the check runs before any queued work is admitted.

**Resuming.** A resumed task skips the queue transition, journals
`execution_resumed { attempt, from_step, reused_calls, redispatched_calls, mode }`,
reloads its transcript, evidence and tool-call count from its checkpoint, and
continues at the next step, ahead of queued work but still one task per caller
at a time. Tools, mission scope, memory grants, caller, context, ownership and
plugin task contexts are re-derived from their owning stores; the checkpoint
never supplies them, and the system prompt is rebuilt so policy and model
changes apply. A paused task stays paused and waits at its first boundary. The
deadline timer is re-armed from the stored deadline. Interrupted work does not
start again while admission is fenced for a rollback. A task the gateway's
shutdown deadline stops with nothing uncertain stays `running`
(`execution_suspended`) and resumes on the next start.

**Operator decisions.** `POST /api/v1/tasks/{id}/recovery`
`{ action, call_id?, result?, note?, deadline_seconds? }` resolves a task held
`awaiting_decision`. It is idempotent per task, attempt and action, and returns
the recovery object:

| Action | Effect |
|---|---|
| `mark_applied` | The pending call is settled `operator_applied` with `result` (at most 64 KiB, checked against the tool's output schema) or "result unavailable"; the work continues without dispatching it. |
| `mark_not_applied` | The pending call is settled `operator_not_applied`; the model is told it was not applied. |
| `retry_with_new_deadline` | The pending call is dispatched again under its original idempotency key, with a new deadline from now (`deadline_seconds`, at most `execution.recovery_max_new_deadline_seconds`). The only way to get a new deadline. |
| `abandon` | Records the decision; nothing continues. |

Because `unknown` is terminal, the first three create a **continuation task**:
the same caller, context, session and prompt (not added to the session again),
idempotency key `recovery:<original id>:<attempt + 1>`, an execution context
whose parent is the original task (`source: continuation`, listed in the
original's lineage `continuations`), and the original's checkpoint with the
pending call settled as decided. A mission continuation copies the mission and
its `TeamResult` names the continuation as `task_id` and lists the operator
decisions in `uncertain_effects`. The original's recovery becomes `resolved`
with `continuation_task_id`; the journals record `recovery_continued` and
`recovery_continuation_of`. `mark_*` keep the original deadline, so they are
offered only while it has not passed. A task held after a cancellation
request is never continued: a decision only records what the operator
established.

**Backends.**

| Backend | Recovery |
|---|---|
| llama.cpp | Full: checkpoints at every model reply and tool boundary, per the table above. |
| Codex | With `providers.codex.durable_threads` (default), thread and turn ids are recorded. (a) When no effectful call is unsettled, the protocol lock verifies thread recovery for the installed CLI, and `thread/read` lists every dynamic tool call in the thread with a settled invocation, the thread is resumed (`CODEX_THREAD_RESUME`). (b) When no effectful tool was ever dispatched, the task restarts on a fresh thread (`CODEX_RESTART_NO_EFFECT`). (c) Otherwise it is held unsupported (`CODEX_THREAD_NOT_VERIFIABLE`). `codex-protocol.lock.json` records `thread_resume_verified` and `thread_read_items_verified`; both are `false` for the observed CLI, so (a) is disabled and the reason says so. |
| Extension `taskExecutor` | Not resumable; held (`EXTENSION_EXECUTION_NOT_RESUMABLE`) when its effect is `possible`. |
| Preview | Not resumable (`PREVIEW_NOT_RESUMABLE`). |

**Never retried automatically:** a dispatched call with a possible effect and no
recorded outcome, unless its tool is idempotent or its own service reconciles
it; HiveMem writes; `news_collect`; extension executors; and anything after the
original deadline. A settled call is never dispatched again.

**State.** Three additive SQLite tables, written in the same transaction as the
journal event of each boundary: `execution_state` (the model transcript after
the last boundary, evidence, tool-call count and Codex thread ids, with a
digest), `tool_invocations` (one row per call: `dispatched` before invocation,
then settled with its result; compacted arguments, so file bytes stay in the
artifact store), and `task_recovery`. `model_result` events also carry `calls`
(id, name, compacted arguments). Execution checkpoints are separate from
context checkpoints; neither reads the other. Rolling back to 3.1.x ignores the
new tables and holds interrupted tasks as `unknown`.

**Channels.** A recovered task has no in-process handler waiting for it, so the
Telegram and Mattermost adapters answer its update themselves: at start and
whenever a task settles they find updates bound to a recovered task with no
recorded delivery, wait for the resumed task (or for the continuation an
operator decision creates), and reply through the usual record-before-send path.
The reply target (conversation, thread, message replied to) is stored with each
inbound claim (`channel_inbound.reply_target_json`). An update that already has
a delivery (queued, sent, failed or unknown) is never sent again, and a task
held awaiting a decision is not answered until its continuation finishes.
Updates claimed before this release have no stored target and are not answered.

**A2A peers.** The A2A surface publishes the outcome of a peer task whose
operation was recovered, through the same task store (GetTask, ListTasks) and
push sender as a live request:

| Operation | Peer task |
|---|---|
| Resumed, then completed | Answer, artifacts and `completed` (or `input_required`), as live. |
| Settled at startup (`failed`, `cancelled`) | `failed` or `canceled`. |
| Held `awaiting_decision` | Stays `working`; a status message gives the reason, and task metadata `ardentRecovery: { status, reason_code }`. |
| Continued after a decision | Follows the continuation: its answer and final state are published for the peer's original task, the A2A operation binding moves to the continuation, and `ardentRecovery.continuation_task_id` names it. |
| Held `unsupported`, or abandoned | `failed` with "Execution outcome is unknown: ...", as an interrupted task with an uncertain effect reports today. |

Each final state is claimed in `a2a_recovery_publications` before it is
published, so it and its push notification are sent at most once.

### Execution ancestry

Every task accepted by this version has an execution context (execution
context v1 from `@hivemagnus/hive-common/execution`): the causal tree it
belongs to, across products. It is **attribution only**: tools, memory scope,
mission scope, team-child admission and artifacts are never selected from it.

```json
{"v": 1, "request_id": "req-1", "root": "hx1:studio:inst-1:request:r-1",
 "parent": "hx1:studio:inst-1:node:n-1", "self": "hx1:ardent:node-a.assistant:task:<task id>",
 "deadline_ms": 1790431800000}
```

- **Where it comes from.** `POST /api/v1/tasks`, `POST /api/v1/missions` and
  `POST /api/v1/preview/tasks` take an optional `execution` field (else the
  `x-hive-execution` header); an A2A message carries it as
  `metadata.hiveExecution`. The task keeps the caller's `root` and
  `request_id`, takes the caller's `self` as its `parent`, and its `self` is
  always `hx1:ardent:<instance>:task:<task id>`, where the instance is
  `ARDENT_INSTANCE_REF`. A missing, malformed or unknown-version value is
  never rejected: the task gets a new root at its own reference. The context
  is not part of the idempotency digest. `deadline_ms` is the earlier of the
  caller's and the task's deadline; it does not change the task deadline.
- **Where it is kept.** The `task_execution` table (`self_ref`, `root_ref`,
  `parent_ref`, `inputs_json`, `context_json` with the task's W3C trace,
  `source`: `caller`, `a2a`, `minted` or `continuation`), written in the same
  transaction as the task, and the `accepted` event's `execution`. A team
  child's context is also stored next to its retained grant, outside the
  grant's digest.
- **Where it goes.** Every llama.cpp request carries a new `x-request-id`, a
  `traceparent` that is a child span of the task trace, and `x-hive-execution`
  with `self` `hx1:ardent:<instance>:attempt:<task id>/<step>/<n>`, `attempt`
  `n` and the deadline. `model_started` events journal `attempt`, `ref`,
  `request_id` and `traceparent`, so a gateway's request log links back to the
  task. `ArdentA2AClient.sendWithReceipt` / `send` / `sendStreaming` take
  `{ execution }` and send it as `metadata.hiveExecution`, so the receiving
  agent's task keeps the root and has the delegating task as its parent.
  Tools receive it as `ctx.execution`, and plugin hooks as `execution` on the
  task context and tool calls. `tool_attempt` events now record the tool's
  `effect`.
- **Artifacts.** An artifact a task registers (`artifact_write`,
  `document_render`, preview research briefs, plugin `register` /
  `registerStream` calls, imports) is stored as manifest 1.1 with
  `provenance.execution: {root, task, step?}`: the task's root, its task
  reference and, while the task runs, the model step
  (`hx1:ardent:<instance>:step:<task id>/<step>`). An imported artifact keeps
  its producer's `execution`, and its import task takes the producer task as
  parent. Every 1.0 view is unchanged, and a task without a context still
  stores manifest 1.0. `ArtifactManifests.executionProvenance(taskId)` returns
  the value.
- **Reading it.** Task responses (`GET /api/v1/tasks`, `GET /api/v1/tasks/{id}`)
  include `execution` when the task has one. `GET /api/v1/tasks/{id}/lineage`
  rebuilds what this profile knows:

```json
{"task_id": "...", "execution": {"v": 1, "root": "...", "self": "..."}, "source": "caller",
 "traceparent": "00-...-...-01", "parent": {"ref": "...", "local_task_id": "..."},
 "children": [{"ref": "...", "local_task_id": "...", "source": "a2a", "created_ms": 0}],
 "continuations": [],
 "model_attempts": [{"step": 0, "attempt": 1, "backend": "llamacpp", "request_id": "...", "ref": "hx1:ardent:...:attempt:<id>/0/1", "started_ms": 0, "usage": null}],
 "tools": [{"call_id": "call-1", "name": "artifact_write", "effect": "artifact-write", "state": "succeeded"}],
 "artifacts": [{"sha256": "...", "name": "map.md", "mime": "text/markdown", "size": 12, "artifact_id": "...", "source": "manifest", "created_ms": 0,
   "schema_version": "1.1", "execution": {"root": "...", "task": "...", "step": "..."}}]}
```

  `parent.local_task_id` is set when the parent is a task of this instance.
  Tool `state` is `attempted`, `succeeded`, `failed`, `denied` or
  `not_dispatched`. Artifacts come from the manifest table (`source:
  manifest`, with renditions as `rendition_of`) and, for artifacts with no
  manifest, the `artifact_registered` and `research_artifacts` events. Everything comes from SQLite, so lineage survives a
  restart; a task accepted before this version has no `execution`, `parent`
  or `children`, but still lists its model attempts, tools and artifacts.
  The `/stream` events are unchanged apart from `accepted`.

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
attribution for the causal tree a task belongs to (see
[Execution ancestry](#execution-ancestry)); they never grant access. They are
set for every task accepted by this version, and absent for older tasks and for
a channel `message`, which has no task yet.

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
npm run pack:check      # packs, installs, and smoke-tests both tarballs
npm run verify          # every gate CI runs, in order
```

The repository is an npm workspace: `client/` is `@hivemagnus/ardent-client`,
which carries Ardent's version. `npm run release:version -- X.Y.Z` bumps both,
and `npm run version:check` (part of verify) fails when they differ. One
`vX.Y.Z` tag publishes the runtime and then the client.

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
