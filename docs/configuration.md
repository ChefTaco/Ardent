# Configuration

Profile configuration, model backends, tools, memory, channels, A2A, Magnus Control tools, scheduled jobs, retries and model policy. Part of the [Ardent](../README.md) documentation.

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
| `execution.recovery.enabled` | `true` | Resume tasks interrupted by a crash or restart. `false` holds them as `unknown`, as before. See [Execution recovery](recovery.md#execution-recovery). |
| `execution.recovery_max_new_deadline_seconds` | `deadline_seconds` | Longest deadline an operator may give `retry_with_new_deadline`, 1-86400. |
| `providers.llamacpp` | required | `base_url`, `model`, `api_key_env`, `request_timeout_seconds`, optional `context_window_tokens`, `max_output_tokens`, `reasoning_effort`. |
| `providers.codex` | required | `command`, `model`, `auth_mode: chatgpt \| api_key` (default `chatgpt`), `durable_threads` (default `true`: task threads are not ephemeral and their ids are recorded for recovery); `approval_policy: never` and `sandbox: read-only` are fixed. |
| `memory` | `{ provider: none }` | See [HiveMem](#hivemem-memory). |
| `research` | disabled | `enabled`, `searxng_url`, `firecrawl_url`, `firecrawl_token_env`. Enables the `news_search`, `news_article`, `news_collect`, and `news_capabilities` tools. |
| `skills` | `directories: [skills]`, `enabled: []` | Only enabled skills are shown to the model. |
| `a2a` | disabled | See [A2A](#a2a). |
| `channels.telegram`, `channels.mattermost` | disabled | See [Chat channels](#chat-channels). |
| `integrations.magnus_control` | disabled | See [Magnus Control tools](#magnus-control-tools). |
| `artifacts.max_bytes` | `2097152` (2 MiB) | Largest artifact a task may store, export to a peer or import, up to 64 MiB. See [Artifact transfer v2](missions-and-artifacts.md#artifact-transfer-v2-and-renditions). |
| `plugins` | `[]` | See [Plugins](plugins.md#plugins). |
| `api` | `127.0.0.1:9910`, `ARDENT_API_TOKEN` | Management listener and the env var holding its bearer token. A non-loopback host is refused; put a TLS proxy in front instead. |

`ardent config schema` prints the full JSON Schema, and `ardent config
validate` checks a profile without starting it.

A few settings come from the environment rather than `config.yaml`:

| Variable | Default | Notes |
|---|---|---|
| `ARDENT_HOME` | `~/.ardent` | Root of the profiles directory and the shared model policy. |
| `ARDENT_API_TOKEN` | — | Management API bearer token (the name is `api.token_env`). |
| `ARDENT_INSTANCE_REF` | `local.<profile>` | The instance part of this runtime's qualified execution references (`hx1:ardent:<instance>:...`). Magnus sets `<node id>.<profile>`. 1 to 96 characters of `A-Z a-z 0-9 . _ -`; any other value stops the runtime from starting and is listed by `ardent config validate`. See [Execution ancestry](recovery.md#execution-ancestry). |

## Tool scheduling

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
interrupted call. [Execution recovery](recovery.md#execution-recovery) re-dispatches an
interrupted idempotent call under the same key and asks `reconcile` before it
resumes a task; a tool that declares neither is held for an operator when one of
its calls is interrupted. `artifact_write` and `document_render` are idempotent
(a repeat under the same key returns the same registration) and reconcile from
their manifest row; `team_handoff`, `team_ask_user`, `team_propose_decision` and
`development_note` reconcile against their local journal rows. HiveMem writes
and `news_collect` declare neither, so they are held.

## HiveMem memory

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

## Chat channels

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

## A2A

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

## Magnus Control tools

Read-only fleet tools for a [Magnus](https://github.com/ChefTaco/magnus)
Control API (fleet inventory, readiness, node health, dependency impact,
anomalies, command status, and more). Enable them with
`integrations.magnus_control.enabled: true` or `ARDENT_MAGNUS_CONTROL_TOOLS=true`.
The base URL comes only from `integrations.magnus_control.base_url` (default
`${ARDENT_MAGNUS_API_URL}`) and the read token from the env var named by
`token_env` (default `ARDENT_MAGNUS_READ_TOKEN`). Bearer tokens are sent only
over HTTPS or to loopback.

## Scheduled jobs

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

## Retries

Every retry site in Ardent names a policy in [`src/retry.ts`](../src/retry.ts),
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

## Model policy

An optional, owner-only `$ARDENT_HOME/model-policy/active.json` selects the
Codex model and reasoning effort and configures context compaction for all
profiles under that home. [`model-policy.default.json`](../model-policy.default.json)
is a starting point; compaction is disabled until you enable it.
