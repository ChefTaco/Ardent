# Operations

The native suite artifact, backup and retention, and journal quiescence. Part of the [Ardent](../README.md) documentation.

## Native suite artifact

Build this repository's `Dockerfile` from the repository root, then select that
reviewed immutable image ID or digest in a [Magnus](https://github.com/ChefTaco/magnus)
checkout:

```bash
npm run build:native-agent -- --product ardent --image PINNED_IMAGE --output NEW_DIRECTORY
```

CI builds the same image on every change, executes its SQLite addon and CLI,
checks that it carries no package manager and runs as a non-root user, and
scans it with Trivy.

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

## Backup and retention

`ardent backup <new directory> [--artifacts]` copies the journal with SQLite's
online backup API, so the gateway can keep running: the copy is consistent,
checked with `PRAGMA integrity_check`, private (`0700` directory, `0600`
files) and described by `backup.json` (size, SHA-256, whether the journal was
idle). `--artifacts` also copies the content-addressed artifact files.
Configuration, identity files and `.env` are not copied. The directory must be
new or empty.

The journal keeps every task unless you prune it. `ardent prune --older-than
90d [--dry-run]` deletes finished tasks (`completed`, `partial`, `failed`,
`cancelled`) last changed before then, with their events, execution state,
settled tool invocations and recovery, settled channel deliveries and their
inbound updates, and artifact manifests; artifact bytes go once no manifest or
remaining journal event names them. It keeps queued, running, paused,
`unknown` and held tasks, tasks whose channel reply is not settled, tasks with
session messages (transcripts are immutable and context checkpoints rest on
them), tasks another task's lineage names, and any task another record refers
to (A2A, team, job or plugin tables). The shortest retention is one day.

```yaml
retention:
  enabled: false        # default; the gateway then prunes once a day
  older_than_days: 90
```

## Journal quiescence

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
{ "ardent_version": "3.5.0", "profile": "assistant", "policy_version": 1,
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

A plugin or extension that creates its own tables in the journal makes the
profile report `unsupported` for each of them, so it is never idle: Ardent
cannot tell whether such a table holds work. Keep extension state outside
`state/ardent.sqlite`, or have the backup tool treat that profile as busy.

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
