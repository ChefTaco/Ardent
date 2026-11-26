# Plugins

The plugin API and its lifecycle hooks. Part of the [Ardent](../README.md) documentation.

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

## Lifecycle hooks

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
[Execution ancestry](recovery.md#execution-ancestry)); they never grant access. They are
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
