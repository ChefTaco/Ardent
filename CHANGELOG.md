# Changelog

## Unreleased

### Repository

- Ardent now lives in its own repository, extracted from the Magnus monorepo
  (`packages/ardent` at commit `084a3292f4b459fe74c91af7e06b37d2aeb2774e`, the 2.1.1 release;
  see `provenance.json`). The package name, version, runtime code and published file set are
  unchanged; package metadata now points to this repository.
- Standalone build, lint, test, OpenAPI and package checks, a CI matrix on Node.js 24.22.1 and
  26.13.0, and a tag-triggered npm publication workflow with provenance through trusted
  publishing behind the protected `npm-publish` environment.
- The typed management client used by the tests is generated in this repository
  (`test/generated/ardent-openapi.ts`); Magnus generates its own from the published package.

## 2.1.1 and earlier

Released from the Magnus monorepo. See the
[Magnus changelog](https://github.com/ChefTaco/magnus/blob/main/CHANGELOG.md) for their notes.
