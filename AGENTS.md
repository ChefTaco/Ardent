# AGENTS.md - Ardent

Guidance for contributors (human or AI) working on Ardent, the headless agent
runtime of the Hive:Magnus suite, published as `@hivemagnus/ardent`. It runs
standalone or under [Magnus](https://github.com/ChefTaco/magnus), which installs
the pinned package on fleet nodes and manages its profiles. In a Hive suite,
assistants are provisioned through Magnus's New Agent workflow
(`./hive.sh ardent setup`); ArdentStudio and the UI (HiveXUI) reach profiles
only through Magnus. This public Apache-2.0 product was extracted from the
Magnus monorepo. Preserve LICENSE, NOTICE, `protocol/LICENSE-A2A.txt` and
`provenance.json`.

## Layout

| Path | Contents |
|---|---|
| `src/` | Runtime, CLI (`cli.ts`, `cli-commands.ts`), management API (`api.ts`), A2A (`a2a*.ts`), channels, jobs, plugins (`plugins.ts`, `plugin-sdk.ts`), native launcher (`native-entry.ts`) |
| `test/` | Vitest suites; `test/interop/` needs Python, `test/fixtures/` the Codex App Server fake and the Python A2A, Hermes and team reference peers |
| `client/` | npm workspace `@hivemagnus/ardent-client`: the browser-safe remote client (`src/`, types generated into `src/generated.ts`), its tests (`test/`) and `examples/cli.mjs` |
| `profiles/assistant/` | Bundled template that `ardent init` copies (config, persona, `grounded-answers` skill) |
| `openapi/ardent.json` | Pinned management OpenAPI document |
| `docs/` | Guides: configuration, management API, missions and artifacts, recovery, plugins, operations (the README links them) |
| `protocol/` | Vendored A2A protobuf and its lock (see `protocol/README.md`) |
| `scripts/` | Release, privacy, secret-scan, protocol, OpenAPI, package and end-to-end checks |
| `Dockerfile` | Native-export image that Magnus turns into a native suite artifact |
| `model-policy.default.json` | Starting point for `$ARDENT_HOME/model-policy/active.json` |

## Privacy

This repository is public. Never commit secrets, private infrastructure, runtime
state, local notes, or real user data, in code, tests, fixtures, docs, or commit
messages:

- No real hostnames, private network domains, IP addresses, usernames, email
  addresses, or home paths. Use placeholders: `example.com` hosts, documentation
  IP ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), `operator` or
  `user` accounts, `/home/operator`, and fake tokens such as `fixture-token`.
- Never commit `.env`, `.env.*` (except `.env.example`), keys, certificates,
  databases, profile state, `AGENTS.local.md`, `CLAUDE.local.md`, or
  `.private-terms`. Read `AGENTS.local.md` when present; never copy it into
  tracked content.
- Install the hooks with `npm run hooks:install` and never bypass them
  (`--no-verify`). They run `scripts/check-private-data.sh` (forbidden paths and
  the optional, gitignored `.private-terms` denylist, also on commit messages),
  `scripts/scan-secrets.sh` and the pinned Gitleaks (`scripts/gitleaks.sh`).
  Install Gitleaks first with `bash scripts/install-gitleaks.sh`; a missing
  binary fails the hooks (see CONTRIBUTING.md).

## Ground rules

- Node.js 24.22.3+ or 26.13.1+, ESM, strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). Match the style of the file you edit.
- Validate every external input with Zod 4 before use: config, HTTP bodies,
  A2A messages, tool arguments, tool results from remote services, and files
  read from the profile.
- Secrets live in the environment. Config stores only the *name* of the
  variable (`token_env`, `api_key_env`) or a `${NAME}` reference. Never log,
  echo, or return secret values.
- Integrations are optional. HiveMem, research backends, Telegram,
  Mattermost, Magnus Control, Hermes compatibility, and Codex must all stay off
  until configured, and the rest of Ardent must work without them. Never
  hard-code their URLs.
- Do not add Python or general agent-framework runtime dependencies.
  Persona-, deployment-, or organization-specific behaviour belongs in a
  plugin, not in this package.

## Runtime invariants

- The model and anything it retrieves never grant permissions. Tools are
  selected by task context (`direct`, `peer`, `scheduled`) and, for peers, by a
  validated team mission's `resources`. Keep peer scoping deny-by-default.
- Every tool declares its effect. Once a tool call with a possible external
  effect has started without a recorded outcome, a cancelled or crashed task is
  `unknown`, never `cancelled`, and the call is never replayed automatically:
  execution recovery resumes only from settled boundaries, re-dispatches only
  reads and idempotent calls, and otherwise needs the tool's `reconcile` proof
  or an operator decision. Do not "fix" an uncertain effect by retrying it.
- Task, event, delivery, and job-window journals in SQLite are the source of
  truth. Keep schema changes additive and migrate existing rows in place.
  Classify every new table, and every new state value of a state table, in
  `JOURNAL_TABLES` (`src/journal.ts`) in the same change: backup and upgrade
  tools such as Magnus's node agent use it (`@hivemagnus/ardent/journal`,
  `ardent journal status`) to decide whether a stopped profile is idle, and
  `test/journal.test.ts` fails on an unclassified table.
- Channel replies and A2A push deliveries are recorded before they are sent so
  a restart cannot send twice.
- Context checkpoints are historical, unverified data. Never use a summary to
  establish policy, permissions, mission state, job ownership, or whether an
  effect completed; reload those from their owning stores.
- For llama.cpp, count the whole input (tool schemas, policy, checkpoint, and
  output reserve) before every model call and fail clearly if it cannot fit.
- Research answers cite only source IDs returned by tools in the same task.
- The scheduler admits a job window only after its ownership check passes;
  plugins may add stricter checks but never bypass the default one.

## Plugin API

`src/plugins.ts` is a public, semver-governed surface. Keep it small and
typed. A new hook needs a test in `test/plugins.test.ts` and documentation in
`docs/plugins.md`. Plugin routes stay behind management-API authentication; plugin
tools stay subject to the same context and mission scoping as built-in tools.

## Management API and OpenAPI

The Magnus node agent calls the management API on loopback; Magnus, its
console, the UI and ArdentStudio reach a profile only through Magnus. Do not
change the shape of existing endpoints. When routes or schemas change, regenerate the
pinned document with `npm run openapi:write` and commit `openapi/ardent.json` and
`client/src/generated.ts`. Magnus generates its own typed client from
the published package, so a shape change also needs a Magnus update.

Magnus deploys and manages Ardent agents, so **every Ardent release is followed
by a Magnus release**: bump its `@hivemagnus/ardent` pins (root and agent
`package.json`, agent `npm-shrinkwrap.json`), regenerate its typed client and
contract (`npm run ardent:openapi:write`), allow any new management routes or
actions in its node agent, and release the agent. Magnus's
`npm run ardent:latest:check` fails while it pins an older Ardent than the
latest published release. The Hive suite only gets a new Ardent through the
Magnus release it pins: Magnus stages the Ardent package that New Agent and
`./hive.sh ardent setup` install.

Plugin packages that pin an exact `@hivemagnus/ardent` peer version need a
matching release **before** Magnus moves its pin: a managed upgrade reinstalls
an installation's retained extension archives with strict peers and holds the
current runtime when a peer does not match.

## Remote client

`client/` publishes `@hivemagnus/ardent-client` with the same version as
Ardent (`npm run release:version -- X.Y.Z` bumps both; `npm run version:check`
fails when they differ). Its default entry must stay browser-safe: no Node
built-ins, `fetch` and web streams only, and `@hivemagnus/hive-common` as its
only runtime dependency (`client/test/browser.test.ts` and `npm run pack:check`
enforce this). Routes it reaches through Magnus follow Magnus's allowlist;
keep the README's Magnus table in step with the Magnus release that adds
routes or actions.

## Tests and gates

Add or update tests with every behaviour change; security-relevant fixes need a
regression test. Tests use loopback fixtures, `example.com` hosts, and fake
tokens only. Before sending a change, run:

```bash
npm run verify   # privacy tests, secret and private-data scans, typecheck, lint, test, build, OpenAPI, pack
```

`npm run cli:check`, `npm run chat:check`, `npm run schedule:check`, and
`npm run native:check` are end-to-end checks against the built CLI; CI runs
them too. `npm run interop` runs A2A interoperability tests that need Python
and the Python A2A SDK (see `scripts/run-interop.mjs`).

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/). Never
overwrite published versions or release tags. Releases publish from a `vX.Y.Z`
tag through `.github/workflows/publish.yml`, which waits for approval on the
`npm-publish` environment and authenticates with npm trusted publishing. It
publishes `@hivemagnus/ardent` and then `@hivemagnus/ardent-client`; each needs
its own trusted publisher on npm (the workflow comments give the command).
