# Security Policy

## Supported versions

Security fixes are released for the latest `2.x` version of `@hivemagnus/ardent`.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/Ardent/security/advisories/new).
Please include:

- the affected version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Keep the management API on loopback (the default) or a private network, and give it a strong
  `ARDENT_API_TOKEN`.
- Keep each profile's `.env` and state directory readable only by the profile owner; Ardent creates
  them owner-only (`0600`/`0700`).
- Store secrets in the environment. Config holds only the variable names (`token_env`,
  `api_key_env`) or `${NAME}` references.
- Enable A2A peers, chat channels, HiveMem, research backends, Magnus Control and Codex only when
  you need them; they are off until configured.
