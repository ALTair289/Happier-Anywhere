# Supply-chain policy

This document defines the source-foundation controls for Happier Anywhere. It
does not replace release provenance, SBOMs, checksums, or signatures generated
for a particular immutable source commit.

## Source identity

`SOURCE_PROVENANCE.json` is the machine-readable source manifest. It binds this
full-history fork to the official upstream repository and the reviewed upstream
base. A release resolves its downstream source commit from Git and records that
exact commit in its provenance and release metadata; the manifest cannot embed
its own commit without becoming circular.

The lightweight distribution repository is separate. Generated deployment-kit
content must bind back to an immutable source commit from this repository.

## GitHub Actions

- Actions stay disabled until G2 local hardening and remote policy readback pass.
- Every workflow declares a top-level read-only or empty `permissions` default.
- Jobs that require a write scope declare it at job level and only for that job.
- External Actions and container Actions are fixed to an immutable commit or
  digest. Floating tags are rejected by the source-foundation policy test.
- Dependabot updates Action pins and Yarn dependencies by pull request against
  `dev`; updates do not bypass review.

Run the dependency-free policy checks with:

```bash
node --test scripts/policy/source-foundation-policy.test.mjs \
  scripts/security/repository-security-scan.test.mjs
```

## Third-party build inputs

Any third-party archive introduced by the build/release lane must record its
exact URL, version/tag/commit, SHA-256 digest, license, allowed platforms, and
safe extraction rules. Downloads fail closed on a digest mismatch and never
fall back to a floating `latest` URL or an unverified repository copy.

The five currently supported build targets are Linux x64 glibc, Linux arm64
glibc, macOS x64, macOS arm64, and Windows x64. Windows arm64 is not claimed as
supported.

## Filename and redacted secret scans

The repository-owned pre-commit scanner uses the Git index as its inventory:

```bash
node scripts/security/repository-security-scan.mjs --filenames-only
node scripts/security/repository-security-scan.mjs
```

The first command checks risky filenames against exact-path classifications in
`SECURITY_SCAN_POLICY.json`. The second also checks tracked bytes for strong
secret signatures. Findings contain only a path, rule ID, and a 16-character
SHA-256-derived fingerprint; matched bytes and line contents are never emitted.

This current-tree scan is not evidence for the G6 full-history/archive scan.
G6 must separately scan all reachable history and the final source archive with
an approved history-capable scanner, using the same redacted-output boundary.
