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
  [Execution recovery](docs/recovery.md#execution-recovery)).
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
ardent mission submit --mission-file mission.json   # a team mission (docs/missions-and-artifacts.md)
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

## Documentation

The guides in [`docs/`](docs/):

- [Configuration](docs/configuration.md): profile configuration, model backends, tools, memory, channels, A2A, Magnus Control tools, scheduled jobs, retries and model policy.
- [Management API](docs/management-api.md): authentication, errors, task lists, metrics, credential rotation, logs and live task streams.
- [Team missions and artifacts](docs/missions-and-artifacts.md): team missions, artifact transfer v2 and renditions, pause, preview and development history.
- [Execution recovery](docs/recovery.md): how interrupted tasks resume or are held, and execution ancestry.
- [Plugins](docs/plugins.md): the plugin API and its lifecycle hooks.
- [Operations](docs/operations.md): the native suite artifact, backup and retention, and journal quiescence.

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
