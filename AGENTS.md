# AGENTS.md - Ardent

Guidance for contributors (human or AI) working on Ardent. This public
Apache-2.0 product was extracted from the Magnus monorepo. Preserve LICENSE,
NOTICE, `protocol/LICENSE-A2A.txt` and `provenance.json`.

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
  the optional, gitignored `.private-terms` denylist, also on commit messages)
  and `scripts/scan-secrets.sh`.

## Ground rules

- Node.js 24.22.1+ or 26.13.0+, ESM, strict TypeScript (`noUncheckedIndexedAccess`,
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
  effect has started, a cancelled or crashed task is `unknown`, never
  `cancelled`, and is never replayed automatically. Do not "fix" an uncertain
  effect by retrying it.
- Task, event, delivery, and job-window journals in SQLite are the source of
  truth. Keep schema changes additive and migrate existing rows in place.
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
`README.md`. Plugin routes stay behind management-API authentication; plugin
tools stay subject to the same context and mission scoping as built-in tools.

## Management API and OpenAPI

The dashboard and the Magnus node agent call the management API. Do not change
the shape of existing endpoints. When routes or schemas change, regenerate the
pinned document with `npm run openapi:write` and commit `openapi/ardent.json` and
`test/generated/ardent-openapi.ts`. Magnus generates its own typed client from
the published package, so a shape change also needs a Magnus update.

Magnus deploys and manages Ardent agents, so **every Ardent release is followed
by a Magnus update**: bump its `@hivemagnus/ardent` pins, regenerate its typed
client, allow any new management routes or actions in its node agent, and
release the agent. Magnus's `ardent:latest:check` fails while it pins an older
Ardent than the latest published release.

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
`npm-publish` environment and authenticates with npm trusted publishing.
