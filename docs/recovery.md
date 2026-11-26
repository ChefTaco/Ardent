# Execution recovery

How interrupted tasks resume or are held, and execution ancestry. Part of the [Ardent](../README.md) documentation.

## Execution recovery

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

## Execution ancestry

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
