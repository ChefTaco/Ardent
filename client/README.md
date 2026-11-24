# @hivemagnus/ardent-client

The supported remote client for [Ardent](https://github.com/ChefTaco/Ardent)
profiles. It submits and follows tasks, reconnects dropped or rotated task
streams from their cursor, cancels, pauses and resumes tasks, drives execution
recovery decisions, reads lineage, and downloads artifacts with resumable,
digest-verified transfers.

It talks to a standalone Ardent management API directly, or to a
Magnus-managed profile through the Magnus Control API. It runs in Node.js 24+
and in modern browsers. It has no framework coupling, and its only runtime
dependency is [`@hivemagnus/hive-common`](https://www.npmjs.com/package/@hivemagnus/hive-common).

The client is versioned and released with Ardent: `@hivemagnus/ardent-client`
X.Y.Z matches the management API of `@hivemagnus/ardent` X.Y.Z. Its types are
generated from Ardent's OpenAPI document.

## Install

```bash
npm install @hivemagnus/ardent-client
```

## Quick start

```ts
import { createArdentClient, direct } from '@hivemagnus/ardent-client';

const ardent = createArdentClient({
  transport: direct({ baseUrl: 'http://127.0.0.1:9910', getToken: () => process.env.ARDENT_TOKEN! }),
});

const { task_id } = await ardent.tasks.submit({ prompt: 'Summarize the release notes', idempotencyKey: 'notes-2026-11-24' });
const task = await ardent.tasks.follow(task_id, {
  onEvent: event => console.log(event.sequence, event.kind),
  onText: text => process.stdout.write(text.kind === 'delta' ? text.text : `\n${text.text}`),
});
console.log(task.state, task.result);
```

Through Magnus, name the node and profile, and authenticate to Magnus:

```ts
import { createArdentClient, viaMagnus } from '@hivemagnus/ardent-client';

const ardent = createArdentClient({
  transport: viaMagnus({ baseUrl: 'https://magnus.example.com', nodeId: 'node-1', profile: 'assistant', getToken: () => session.token }),
});
```

`baseUrl` is the Magnus origin; the client adds `/api/v1`. Behind a proxy that
serves Magnus's `/api/v1` under another path, such as a Hive console's
`/api/magnus`, give that path as `apiBase` instead (exactly one of the two):

```ts
viaMagnus({ apiBase: 'https://console.example.com/api/magnus', nodeId: 'node-1', profile: 'assistant', getToken: () => session.token });
```

`client/examples/cli.mjs` in the Ardent repository runs submit, follow and
download end to end:

```bash
ARDENT_TOKEN=... node examples/cli.mjs --url http://127.0.0.1:9910 --prompt "Write the report" --out ./downloads
MAGNUS_TOKEN=... node examples/cli.mjs --magnus https://magnus.example.com --node node-1 --profile assistant --prompt "Write the report"
MAGNUS_TOKEN=... node examples/cli.mjs --magnus-api https://console.example.com/api/magnus --node node-1 --profile assistant --prompt "Write the report"
```

## API

```ts
createArdentClient({ transport, execution?, signal?, retryPolicy? }): ArdentClient
direct({ baseUrl, getToken, headers?, fetch? }): ArdentTransport
viaMagnus({ baseUrl | apiBase, nodeId, profile, getToken, headers?, fetch? }): ArdentTransport

ardent.tasks.submit({ prompt, idempotencyKey?, sessionId?, execution?, signal? }): Promise<TaskAccepted>
ardent.tasks.get(id, { signal? }): Promise<Task>
ardent.tasks.list({ limit?, signal? }): Promise<Task[]>
ardent.tasks.events(id, { after?, signal? }): Promise<TaskEvent[]>
ardent.tasks.cancel(id, { signal? }): Promise<Task>
ardent.tasks.pause(id, { signal? }) / resume(id, { signal? }): Promise<TaskAdmission>
ardent.tasks.follow(id, { after?, onEvent?, onText?, onConnect?, signal? }): Promise<Task>

ardent.sessions.list({ context?, signal? }): Promise<Session[]>
ardent.sessions.open(key, { context?, reset?, signal? }): Promise<Session>
ardent.sessions.messages(id, { signal? }): Promise<SessionMessage[]>

ardent.recovery.get(id, { signal? }): Promise<Recovery | null>
ardent.recovery.decide(id, { action, callId?, result?, note?, deadlineSeconds? }, { signal? }): Promise<Recovery>
ardent.lineage(id, { signal? }): Promise<Lineage>

ardent.artifacts.list(taskId, { signal? }): Promise<ArtifactRecord[]>
ardent.artifacts.manifest(sha, { v2?, signal? }): Promise<ArtifactRecord | ArtifactRecordV2>
ardent.artifacts.renditions(sha, { signal? }): Promise<ArtifactRendition[]>
ardent.artifacts.download(sha, { rendition?, resumeFrom?, onProgress?, signal?, maxResumes? }): Promise<ArtifactDownload>
ardent.artifacts.import({ peer_id, a2a_task_id, artifact_id, task_id? }, { signal? }): Promise<{ import_id }>
ardent.artifacts.imports({ limit?, signal? }) / importStatus(id, { signal? })

ardent.status({ signal? }): Promise<OperationalStatus>
ardent.capabilities({ signal? }): Promise<ArdentCapabilities>
```

Response types (`Task`, `Recovery`, `Lineage`, `ArtifactRecord` and the rest)
are the documented response bodies, and `paths`, `operations` and
`components` are exported for anything else in the API.

### Following a task

`tasks.follow` reads `GET /api/v1/tasks/{id}/stream` until `task.done` and then
returns the task. Ardent closes a stream after 60 seconds, and networks drop
connections; the client reconnects with the last event sequence (`after` and
`Last-Event-ID`), so every journaled event reaches `onEvent` once and in order.
Live reply text (`onText`) is not journaled: after a reconnect a `text`
snapshot of the current step replaces what the `delta`s built up. To resume a
follow later, pass the last `event.sequence` you handled as `after`.

### Downloads

`artifacts.download(sha)` returns `{ stream, sha256, size, offset, mime, filename }`.
The stream pulls `GET /api/v1/artifacts/{sha256}/content` with bounded memory
and hashes the bytes as they pass. When the connection drops it resumes with
`Range` and `If-Range` (up to `maxResumes`, default 5). It closes only after
the whole file hashed to the artifact's SHA-256; otherwise it errors with
`DigestMismatchError`, and you must discard the bytes.

To continue a download that an earlier process or page started, pass the
bytes you kept as `resumeFrom` (a `Blob`, `ArrayBuffer`, typed array,
`ReadableStream` or async iterable). They are hashed again as a stream, and the
transfer continues after them, so the final check still covers the whole file.
The stream then yields only the remaining bytes, starting at `offset`.

```ts
// Node: write to a partial file and keep it only once the stream closed verified.
import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Writable } from 'node:stream';

const download = await ardent.artifacts.download(sha, { onProgress: p => console.log(p.received, '/', p.total) });
await download.stream.pipeTo(Writable.toWeb(createWriteStream('report.pdf.partial')));
await rename('report.pdf.partial', 'report.pdf');
```

```ts
// Browser: collect into a Blob and hand it to the user.
const download = await ardent.artifacts.download(sha);
const blob = await new Response(download.stream).blob();
```

`rendition: { purpose: 'display' | 'model_input' | 'download', maxBytes?, acceptMime?, needsAlpha? }`
picks a preview or model-input rendition with HiveCommon's `selectRendition`;
`download` always resolves to the original.

### Recovery decisions

A task interrupted with an unsettled external effect is held `unknown` with a
recovery status `awaiting_decision`. `recovery.get(id)` returns it (or `null`
for a task that was never interrupted), and `recovery.decide(id, { action })`
records `mark_applied`, `mark_not_applied`, `retry_with_new_deadline` or
`abandon`. The work continues as a linked continuation task:

```ts
const recovery = await ardent.recovery.get(id);
if (recovery?.status === 'awaiting_decision') {
  const decided = await ardent.recovery.decide(id, { action: 'mark_applied', result: { written: true }, note: 'Checked the target system' });
  await ardent.tasks.follow(decided.continuation_task_id!);
}
```

Repeating a decision returns the same outcome; a different decision raises
`ConflictError`.

### Execution context

`execution` (an execution context v1 from `@hivemagnus/hive-common/execution`)
is sent with every submission, on the client or per `submit`. It is attribution
only and never grants access. Ardent records it as the task's parent; through
Magnus it is passed on only when Magnus advertises it, and otherwise dropped,
never failing the submission.

## Authentication, retries and cancellation

- `getToken({ refresh })` is called for every request. After a `401` it is
  called once more with `refresh: true`; a second `401` raises
  `UnauthorizedError`. Cache the token yourself if fetching it is expensive.
- Reads, and direct submissions, cancels, pauses, resumes and recovery
  decisions (which Ardent makes idempotent), are repeated on network errors,
  `408`, `425`, `429` and `5xx`, honouring `Retry-After`, `x-hive-retry:
  exhausted` and the execution context's `deadline_ms`. `retryPolicy` tunes
  it. Actions through Magnus are never repeated automatically: Magnus
  requires an unconfirmed outcome to be inspected first.
- A submission without `idempotencyKey` gets a random one, so its retries are
  safe. Magnus accepts only UUID keys; through Magnus another key is replaced
  by a stable UUID derived from it.
- Every call takes an `AbortSignal`; the client's `signal` aborts them all.

## Errors

Every error is an `ArdentClientError`, which extends HiveCommon's `HiveError`
(`status`, `code`, `details`, `requestId`).

| Error | When |
|---|---|
| `UnauthorizedError` | The token was refused, also after a refresh |
| `NotFoundError` | The task, session, artifact or import does not exist |
| `ConflictError` | The task's state refuses the request (a finished task cannot pause, a recovery was decided differently); `idempotency: true` when the idempotency key was used for different content |
| `UnsupportedCapabilityError` | The route is not available through this transport (`capability`, and `requiredVersion` / `installedVersion` when Magnus says) |
| `TransportError` | A network failure, a stream or download that could not be resumed, `502`/`503`/`504`, or a response that is not what the API documents |
| `DigestMismatchError` | The downloaded bytes do not hash to the artifact's SHA-256 (`expected`, `actual`) |

## Node and browsers

| | Node.js 24+ | Modern browsers |
|---|---|---|
| Tasks, sessions, recovery, lineage, status | Yes | Yes |
| Task streams with reconnect (`fetch` + web streams, so headers carry the token) | Yes | Yes |
| Downloads: streaming, `Range` resume, SHA-256 verification | Yes | Yes |
| Resuming a download in a later process or page (`resumeFrom`) | Yes, from the partial file | Yes, from bytes you kept (for example a `Blob`); the client stores nothing across reloads |
| Writing to disk | With `node:fs` (see above) | Through your own `Blob` or File System Access code |

The default entry imports no Node built-ins. Cross-origin browser use needs the
server (or Magnus) to allow the origin with CORS, including the
`Authorization`, `Range`, `If-Range`, `Last-Event-ID` and `x-hive-execution`
request headers and the `Content-Range`, `ETag`, `Repr-Digest`,
`X-Content-SHA256` and `Content-Disposition` response headers.

## Direct and through Magnus

Directly, every route is available. Through Magnus, only the routes Magnus
allows; the others raise `UnsupportedCapabilityError`. `capabilities()` reports
what is available, from the profile's `/status` and Magnus's installation
report.

| Client call | Ardent route | Through Magnus |
|---|---|---|
| `tasks.submit` | `POST /api/v1/tasks` | action `task-submit` (`execution` top level when Magnus advertises `lineage`) |
| `tasks.get`, `list`, `events` | `GET /api/v1/tasks[/{id}[/events]]` | read `tasks[/{id}[/events]]` |
| `tasks.cancel`, `pause`, `resume` | `POST /api/v1/tasks/{id}/cancel\|pause\|resume` | actions `task-cancel`, `task-pause`, `task-resume` (target: task ID) |
| `tasks.follow` | `GET /api/v1/tasks/{id}/stream` | `GET …/tasks/{id}/stream` relay |
| `sessions.list`, `messages` | `GET /api/v1/sessions[/{id}/messages]` | read `sessions[/{id}/messages]` |
| `sessions.open` | `POST /api/v1/sessions` | action `session-open` |
| `artifacts.list`, `manifest` | `GET /api/v1/tasks/{id}/artifacts`, `/api/v1/artifacts/{sha}/manifest` | reads |
| `recovery.get`, `lineage` | `GET /api/v1/tasks/{id}/recovery\|lineage` | reads, from Magnus 3.3.0 |
| `recovery.decide` | `POST /api/v1/tasks/{id}/recovery` | action `task-recovery` (target: task ID, body: the decision), from Magnus 3.3.0 |
| `artifacts.download` | `GET /api/v1/artifacts/{sha}/content` | `GET …/artifacts/{sha}/content` with Range, from Magnus 3.3.0 |
| `artifacts.renditions`, `manifest({ v2: true })`, `imports`, `importStatus` | `GET /api/v1/artifacts/{sha}/renditions\|manifest/v2`, `/api/v1/artifacts/imports[/{id}]` | reads, from Magnus 3.3.0 |
| `artifacts.import` | `POST /api/v1/artifacts/imports` | action `artifact-import`, from Magnus 3.3.0 |
| `status`, `capabilities` | `GET /api/v1/status` | read `status`, plus `GET /api/v1/ardent/installations/{nodeId}` |

Magnus reads are `GET {apiBase}/ardent/installations/{nodeId}/profiles/{profile}/{route}`
(`apiBase` is `{baseUrl}/api/v1` when `baseUrl` is given)
and actions `POST …/action` with `{ action, target?, body? }`; the client
unwraps Magnus's `{ success, data }` envelope. A route Magnus refuses (`403`,
`404`, or `400` for an action it does not know, while it does not advertise the
capability) and Magnus's `409 unsupported_capability` or `AGENT_UPGRADE_REQUIRED`
become `UnsupportedCapabilityError`. A linked service identity may need an
`x-acting-subject` header for some actions; pass it in `headers`.

## Out of scope

The A2A protocol (peer agents calling Ardent's A2A surface) is out of scope; use
an A2A SDK such as `@a2a-js/sdk` for peer calls. Configuration, identity,
skills, peers, missions and previews are management concerns that Magnus and
the Ardent CLI handle; their routes are in the exported `paths` types.

## License

Apache-2.0. See LICENSE and NOTICE.
