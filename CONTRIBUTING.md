# Contributing to Ardent

Thanks for your interest in improving Ardent! Bug reports, documentation fixes, and pull requests
are all welcome.

## Getting set up

```bash
npm ci                # Node.js 24.22.1+ or 26.13.0+
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
