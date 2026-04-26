# Security Policy

Woton treats encryption, file integrity, and parser safety as core project requirements.

## Supported Versions

Woton is currently pre-1.0. Security fixes are handled on the default development line until a stable support policy exists.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security issues by email to the project maintainers listed in the repository metadata. Include:

- affected Woton version or commit.
- operating system and Node.js version.
- minimal reproduction steps.
- whether the issue exposes plaintext, bypasses authentication, corrupts data, or causes denial of service.

If email contact is unavailable, open a GitHub issue with only a minimal, non-sensitive summary and ask for a private disclosure path.

## Scope

Security-sensitive areas include:

- `.wtdb` encryption and authentication.
- password handling and password rotation.
- file locking and atomic writes.
- parser behavior for the Woton language.
- plaintext exposure in files, errors, logs, or test artifacts.

## Expectations

Woton has not had an external security audit. Do not treat the current release as audited production cryptography.

When a report is confirmed, maintainers should:

1. acknowledge the report.
2. reproduce the issue privately.
3. add a regression test where practical.
4. publish a fix and document impact.

Additional design notes are maintained in `docs/SECURITY.md`.
