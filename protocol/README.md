# A2A protocol pin

`a2a.proto` and `LICENSE-A2A.txt` are from the official A2A `v1.0.1` tag at
commit `3303592588e388e62e0f69f701af531d2f4e3991`. The pinned official
TypeScript SDK `@a2a-js/sdk@1.2.1` supplies generated protobuf codecs and the
three transport bindings. Ardent implements its executor, caller policy,
peer routing, and SQLite task storage in `src/a2a*.ts`.

Run `npm run protocol:check` in this package to verify the vendored protobuf
digest and installed SDK version against `lock.json`. A spec or SDK upgrade
requires updating the lock and running all interop tests before changing the
declared interfaces.
