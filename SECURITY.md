# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include:

- what is affected and how to reproduce it,
- the impact you expect,
- any fix you have in mind.

You can expect an acknowledgement within seven days. Please allow time for a fix to be released
before disclosing the problem publicly.

## Supported versions

PR Buddy has not had a release yet. Fixes are made on the `main` branch.

## Scope

In scope: anything that lets pull request content, configuration or a webhook make PR Buddy
execute code, read data it should not, report under a false identity, or stop working.

Out of scope: findings that are merely unhelpful. Please open a normal issue for those.

## How PR Buddy is designed to be safe

The threat model and the controls in place are described in
[docs/SECURITY.md](docs/SECURITY.md).

PR Buddy holds no security certification, and it does not replace dedicated secret scanning,
static analysis or dependency scanning.
