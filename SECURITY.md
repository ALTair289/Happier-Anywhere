# Security policy

## Supported code

Security fixes are developed against the current protected downstream source
branch. Published versions remain immutable: a defective release is replaced
by a new version, never by moving a tag or replacing an asset.

This repository is a downstream fork. Issues that also affect unmodified
Happier code may need coordinated disclosure to the upstream project at
https://github.com/happier-dev/happier/security.

## Reporting a vulnerability

Do not include exploit details, credentials, private keys, access tokens,
personal data, or unredacted logs in a public issue.

Use GitHub private vulnerability reporting when it is available:
https://github.com/ALTair289/Happier-Anywhere-Source/security/advisories/new

If that entry point is unavailable, open a minimal public issue that asks the
maintainer to establish a private contact channel. Include no sensitive detail
in that issue.

## Repository and release controls

- GitHub Actions remain disabled until local policy checks and the remote G2
  ruleset/environment checks have passed.
- Workflow defaults are read-only. A job that publishes or changes repository
  state must declare only its required write scopes at job level.
- Third-party Actions use complete 40-character commit SHAs.
- Signing private keys and deployment credentials never enter Git, workflow
  logs, artifacts, issues, or task messages.
- The upstream public release key is an independent trust root and must not be
  replaced by the Happier Anywhere downstream public key.

The repository scan commands in `SUPPLY_CHAIN.md` emit only file paths, rule
identifiers, and redacted fingerprints. They never print matched secret bytes.
