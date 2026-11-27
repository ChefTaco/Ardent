# Management API

Authentication, errors, task lists, metrics, credential rotation, logs and live task streams. Part of the [Ardent](../README.md) documentation.

## Management API

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
`checks`). Readiness also lists `problems`, and its status is `not_ready` when
it answers 503 (Ardent 3.5.1 and earlier said `degraded`). It probes the
selected backend only once the configuration is complete. `GET /api/v1/providers`
starts the Codex App Server only for a Codex profile (`?probe=codex` asks a
llama.cpp profile too; `auth_mode` is `not_selected` otherwise); readiness and
`/providers` share one Codex account probe for 30 seconds.

## Metrics

`GET /api/v1/metrics` (management token) answers in the OpenMetrics text
format: `ardent_build_info`, `ardent_tasks{state}`,
`ardent_recovery_tasks{status}`, `ardent_job_windows{state}`,
`ardent_channel_deliveries{state}`, `ardent_a2a_push_deliveries{state}`,
`ardent_a2a_rate_limited_total{scope}` (A2A `429`s since the process started,
by `ip`, `peer` or `tasks`), and per Mattermost bot `account` and `channel`
`ardent_mattermost_catchup_boundary_age_seconds` (age of the newest post up to
which every older post is settled), `ardent_mattermost_catchup_walk_age_seconds`
and `ardent_mattermost_catchup_gaps`. Gauges are read from the journal when
scraped. A Prometheus job sets `metrics_path: /api/v1/metrics` and the bearer
token.

## Rotating credentials

The management token and the A2A peer tokens can change without a restart.
Write the new values into the profile environment file the gateway started
from (`--env-file`, default `<profile>/.env`), then call, with the token in use:

- `POST /api/v1/credentials/management/reload`: the gateway requires the new
  `api.token_env` value from then on; the replaced token is still accepted for
  `overlap_seconds` (body `{ "overlap_seconds": 300 }` is the default, 0 to
  3600), so callers can switch over.
- `POST /api/v1/credentials/peers/reload`: every configured peer's inbound and
  outbound token is re-read and validated as at startup; a replaced inbound
  token is still accepted for the overlap. When a value is not valid nothing
  changes (`422`). Adding or removing peers still needs a restart.

Neither returns a token. `POST /api/v1/memory/credential/reload` does the same
for the HiveMem credential.

## Operational logs

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

## Live task streams

`GET /api/v1/tasks/{id}/stream` is a server-sent event stream. It sends:

| Event | Data | Notes |
|---|---|---|
| `task.event` | A journal event | The event `id` is the journal sequence. Resume with `Last-Event-ID` or `?after=` |
| `task.text` | `{step, text}`: the visible reply text of the current model step | Sent on connect and when a new step starts showing text |
| `task.delta` | `{step, text}`: text to append | |
| `task.done` | The finished task | Its `result` is the authoritative answer. Sent last, after every event the task journals, including those a run records after its final state (a direct research task's `method_reflection` and `memory_stored`) |

The stream wakes as soon as the gateway journals an event for the task (events
another process writes arrive within a second), sends a `: keepalive` comment
when it has been idle for 15 seconds, and closes after 60 seconds; reconnect to
continue.
[`@hivemagnus/ardent-client`](../client/README.md) does this for you
(`tasks.follow`).

Live text works the same for every backend and caller:
- It holds only what a user would see. Structured output, such as tool or research JSON, is never streamed.
- It is not journaled and has no event id. A reconnect receives a `task.text` snapshot instead of a replay.
- Codex sends its answer as one piece when the turn completes.

`ardent chat` uses the same rule to print replies as they arrive.
