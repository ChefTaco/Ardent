# Contributing to Ardent

Thanks for your interest in improving Ardent! Bug reports, documentation fixes, and pull requests
are all welcome.

## Getting set up

```bash
npm ci                # Node.js 24.22.3+ or 26.13.1+
npm run hooks:install # privacy and secret checks on commit and push
npm run build
```

Ardent is a single npm package, `@hivemagnus/ardent`. It runs standalone, or under
[Magnus](https://github.com/ChefTaco/magnus) management, which installs it from npm.

## Before opening a pull request

Run the same gates that CI runs:

```bash
npm run verify
npm run cli:check
npm run chat:check
npm run schedule:check
npm run native:check
```

- Keep TypeScript strict and follow the style of the surrounding code. See [AGENTS.md](AGENTS.md).
- Add or update tests for behaviour changes; security fixes need a regression test.
- If you change a management API route or schema, run `npm run openapi:write` and commit the
  updated `openapi/ardent.json` and `test/generated/ardent-openapi.ts`.
- Never commit `.env` files, keys, certificates, databases, profile state, or other credentials,
  or details of private infrastructure (real hostnames, IPs, usernames, home paths). The git hooks
  in `.githooks/` enforce this. See [AGENTS.md](AGENTS.md) for the full rules, which apply to people
  and AI agents alike.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:` and so on), with an optional scope such as `fix(a2a): ...`.

## Reporting bugs and requesting features

Open a GitHub issue. For security issues, follow [SECURITY.md](SECURITY.md) and do **not** open a
public issue.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).

## Secret scanning

Install the pinned, checksum-verified Gitleaks CLI before contributing:

```bash
bash scripts/install-gitleaks.sh
git config core.hooksPath .githooks
bash scripts/test-gitleaks.sh
bash scripts/gitleaks.sh --staged
bash scripts/gitleaks.sh --history
```

Gitleaks 8.30.1 is free and runs directly; no paid Action or organization license
is required. The installer supports Linux and macOS on x64 and ARM64 and uses the
user cache, without sudo. Other platforms can put that exact version on PATH.
Missing or incompatible binaries fail the hooks rather than skipping checks.

The commit hook scans an export of the exact Git index, including force-added
ignored files. The push hook scans every outgoing ref's commit range, including
secrets deleted in a later commit. New refs or unavailable remote bases receive
a complete reachable-history scan. Existing privacy checks still run.

The `Gitleaks` workflow scans full reachable history on pushes, pull requests
and merge queues, and runs synthetic regression checks. Maintain `Gitleaks` as a
required status check on the default branch. CI runs after upload and can block
merging; local hooks and GitHub's native push protection help prevent upload.
Local hooks can be bypassed or absent on other clones, so install them in each
clone. No scanner guarantees detection of arbitrary secrets.

All output redacts matched secrets. Inline `gitleaks:allow` comments are ignored.
Review findings privately: rotate a real exposed credential and remove it through
the appropriate incident process. Never add real credentials to an allowlist.
Any false-positive exception in `.gitleaks.toml` must match both one exact value
and a specific file, with a reason; do not exempt whole test or documentation
directories or disable built-in detection rules.
