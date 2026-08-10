# Happier deployment kit

The deployment kit is a portable, integrity-checked artifact set for a
self-hosted Happier topology. It is designed for one Controller, one or more
Agent machines, browsers, and the native Happier Android and iOS apps.

This document describes the target deployment model and the current delivery
boundaries. It must not be read as proof that a particular machine has already
been installed or exposed.

## Topology

- Exactly one Controller owns the Relay.
- Each Agent runs the Happier daemon and the local Codex provider. An Agent may
  be the Controller machine or a separate Windows, Linux, or macOS host.
- SSH-managed machines run Agent components only. They do not start another
  Relay unless the operator intentionally creates a separate deployment.
- Browsers and native apps connect to the Controller over HTTPS.
- The supported private access profile is loopback Relay plus an authenticated
  HTTPS gateway such as Tailscale Serve. Tailscale Funnel and plaintext LAN
  publication are disabled by policy.

The standalone native Relay and Docker Relay are mutually exclusive backends.
Never point both backends at the same live data directory or run both as writers.

## Supported native targets

The deployment manifest recognizes these canonical target combinations:

| Operating system | Architecture | Target ID |
| --- | --- | --- |
| Windows | x64 | `windows-x64` |
| Linux (glibc) | x64 | `linux-x64-glibc` |
| Linux (glibc) | arm64 | `linux-arm64-glibc` |
| macOS | x64 | `darwin-x64` |
| macOS | arm64 | `darwin-arm64` |

Every declared target includes both an Agent payload and a Controller payload.
The installer selects the payload by role; this does not mean every machine
should run both roles.

## Kit layout

A materialized kit contains:

- a versioned deployment manifest and its JSON Schema;
- an artifact inventory and SHA-256 checksums;
- native Agent and Controller payloads for the declared targets;
- PowerShell and POSIX bootstrap scripts for both roles;
- a mobile distribution mode and pairing contract that distinguish included signed artifacts from externally obtained Apps;
- this operator guide.

The manifest rejects credential-like artifact paths, but the assembler does
not inspect arbitrary archive contents. Its credential-content status is
`not-verified`; audit every supplied artifact before distributing the kit and
do not infer that login tokens, pairing secrets, master secrets, SSH private
keys, `.env` data, or signing credentials are absent merely because assembly
succeeded. A kit using `mobile.distribution.mode: external-app` explicitly
contains no APK, AAB, or IPA and performs no mobile artifact, signing,
publication, channel-availability, or real-device verification. Android and
iOS binaries may be represented as included signed artifacts only when supplied
by an authorized mobile release pipeline and verified against declared
receipts.

The current assembler supports the `local` channel. It refuses stable, preview,
or development release claims until an authenticated release-signing pipeline
owns those channels. A local kit is an integrity-checked artifact mirror, not a
publicly authenticated release.

## Assemble a local kit

From a clean, trusted checkout, create a kit specification that references the
already-built canonical component artifacts, then run:

```text
node scripts/pipeline/deployment-kit/assemble-deployment-kit.mjs \
  --spec <kit-spec.json> \
  --out <new-empty-output-directory>
```

Every `sources` entry in the assembly specification is a closed descriptor,
not a bare path:

```json
{
  "sources": {
    "agent-linux-x64": {
      "archive": "artifacts/happier-v0.2.10-linux-x64.tar.gz",
      "checksums": "artifacts/checksums-happier-v0.2.10.txt"
    },
    "controller-linux-x64": {
      "archive": "artifacts/happier-server-v0.2.10-linux-x64.tar.gz",
      "checksums": "artifacts/checksums-happier-server-v0.2.10.txt"
    }
  }
}
```

The archive and checksum basenames must match the canonical CLI/server release
builder names for the manifest role, version, OS, and architecture. The
checksum receipt must contain the manifest digest for that exact archive. Bare
files and renamed outputs are refused; a server build stopped by its runtime
dependency preflight cannot itself emit the archive/checksum pair consumed
here. The assembler does not prove that a locally supplied pair was emitted by
that builder: local source reproducibility remains `not-verified`. The receipt
is not a signature or an archive-content audit; the trusted release pipeline
owns authenticated stable/preview/dev receipts.

The output directory must not already exist. The assembler rejects path
traversal, symbolic-link or junction escapes, hard links, special filesystem
entries, untracked files/directories, artifact hash/size mismatches,
non-canonical targets or variants, credential-like manifest paths, conflicting
Relay backends, and unsafe network policy. A successful verification therefore
locks the complete file tree represented by `SHA256SUMS`; it is not a content
credential scan.

Before moving the kit to another computer, copy the whole directory and verify
its `SHA256SUMS` on the destination. Do not execute artifacts directly from a
removable or network-writable location; first copy them into a restricted local
staging directory and verify them there.

## Generate a modular GitHub project

The complete offline kit remains the disaster-recovery and air-gapped format.
It is not the default online transport. A small GitHub project can be generated
from either the original assembly spec or an already verified kit without
copying any native archive into the project:

```text
node scripts/pipeline/deployment-kit/assemble-github-project.mjs \
  --kit <verified-kit-directory> \
  --out <new-empty-project-directory> \
  --repository ALTair289/Happier-Anywhere \
  --repository-availability not-verified \
  --release-public-key <project-minisign-public-key>
```

Use `--spec <kit-spec.json>` instead of `--kit` when producing the project
directly from canonical local release archives and checksum receipts. Exactly
one input is required. The command verifies the selected input before writing
the project. `--release-public-key` lets a downstream deployment project use
its own Minisign trust root without changing Happier's canonical release key.
The option accepts only a regular file; when omitted, the canonical Happier
release public key remains the default.

Keep `--repository-availability not-verified` while preparing draft Releases.
Set it to `verified` only after the exact versioned tags, signed checksum
receipts, archive digests, byte sizes, and anonymous download URLs have all
been published and independently verified.

The generated project contains English `README.md` and Simplified Chinese
`README.zh-CN.md` guides with bidirectional language links, a formal catalog,
a tab-separated asset index, the existing Agent/Controller/SSH bootstraps, the
Happier Minisign public key, download-only PowerShell and Bash helpers, a
verification workflow, and a project-tree checksum. Both guides are rendered
from the same catalog facts. It contains no `.tar.gz` files. Agent and Relay
archives remain separate GitHub Release assets under versioned component tags:

- Agent: `cli-v<version>` / `happier-v<version>-<os>-<arch>.tar.gz`;
- Relay: `server-v<version>` / `happier-server-v<version>-<os>-<arch>.tar.gz`.

The Controller profile downloads the Agent CLI and Relay for one target. The
Agent profile downloads only that target's CLI. The SSH Agent profile downloads
only a Linux or macOS CLI. The helpers require GitHub HTTPS URLs, a valid
Minisign signature over the component checksum receipt, the catalog SHA-256,
and the declared byte size to agree. They stage files only: they never elevate,
install, start a service, configure Tailscale, or expose a port.

This layout lets a destination download only what it needs and lets an operator
prepare a selective offline cache. It also keeps the source repository small:
native binaries belong in GitHub Releases, not Git history. GitHub does not
make tags or Release assets intrinsically immutable; the signed checksum,
catalog SHA-256, and byte-size checks provide the content pin. The catalog marks
release availability `not-verified` until the referenced versioned tags and
signed assets are published and independently verified; a post-publication
project may then explicitly record `verified`. Browser clients still require no package,
and the Happier Android/iOS App remains an external signed distribution as
declared by the mobile contract.

## Install the Controller

1. Select the Controller payload matching the destination OS and architecture.
2. Verify the payload against the manifest and `SHA256SUMS`.
3. Extract it into a newly created, access-restricted temporary directory.
4. Run the generated `bootstrap/controller.ps1` on Windows or
   `bootstrap/controller.sh` on Linux/macOS.
5. The script delegates installation to the canonical Happier owner. It does
   not create a second service implementation. The Relay must be installed with
   loopback host `127.0.0.1` and the protected manifest port `3005`. The v1
   bootstrap accepts no manifest path, so it rejects an ambient
   `HAPPIER_BOOTSTRAP_RELAY_PORT` instead of allowing an override.
6. Confirm the Relay process, health endpoint, database backend, file paths, and
   listener address before configuring an HTTPS gateway.
7. Configure exactly one authenticated HTTPS gateway. For the Tailscale profile,
   verify Serve status and independently confirm Funnel remains disabled.

Do not launch the server binary directly: its generic API default may listen on
all interfaces. Use the canonical `happier relay host install` flow so the
loopback policy is explicit and auditable.

## Install a local Agent

1. Select and verify the Agent payload for the host.
2. Configure the HTTPS Relay origin with `happier server set`.
3. Authenticate interactively or with a short-lived operator-approved flow.
   Never put a long-lived token in a script or command history.
4. Install the user-mode daemon through `happier service install`.
5. Verify the daemon account, current Codex home/session identity, and
   Direct-versus-Takeover behavior before treating the Agent as accepted.

The generated Agent scripts preserve those canonical commands and do not alter
firewall rules, Tailscale state, shell execution policy, or service definitions.

## Install an SSH Agent

For an online destination, the existing `happier machine setup --ssh` release
flow remains available.

For an offline destination, run the generated SSH Agent bootstrap on the
Controller. The payload must be the verified, extracted Agent payload matching
the remote Linux/macOS OS and architecture; do not pass the archive or a
Controller payload.

Windows Controller (PowerShell 5.1+):

```text
bootstrap/ssh-agent.ps1 \
  -HappierBinary <controller-happier.exe> \
  -SshTarget <user@linux-or-macos-host> \
  -CliPayload <verified-extracted-agent-payload-root> \
  -ServerUrl <https-relay-origin> \
  [-WebappUrl <https-webapp-origin>] [-Yes]
```

Linux/macOS Controller (POSIX shell):

```text
bootstrap/ssh-agent.sh \
  <controller-happier> \
  <user@linux-or-macos-host> \
  <verified-extracted-agent-payload-root> \
  <https-relay-origin> \
  [https-webapp-origin] [--yes]
```

Both scripts pass `--cli-payload` to the canonical
`happier machine setup --ssh` owner. The payload root name, remote
OS/architecture, binary, package distribution, file types, and link/reparse
boundaries are validated before the existing SCP, version-directory, and
daemon-service owner is invoked. The path is local operator input and must
never be copied into logs or diagnostics. Omit `-Yes`/`--yes` to review
host-trust and pairing prompts interactively; supplying it explicitly accepts
those canonical prompts.

If the installed CLI does not expose `--cli-payload`, that build does not yet
support offline SSH bootstrap. Do not replace it with manual archive extraction
and an ad-hoc service script; that creates a second upgrade owner.

## Browser and native apps

The embedded Web UI is served through the same private HTTPS Relay origin. The
kit does not claim installable-PWA or offline-service-worker support.

For a local kit without signed mobile artifacts, use the explicit
`external-app` / `not-included` contract. Its Android and iOS channel names are
independent acquisition guidance, not proof that a store or MDM channel has
published the declared version. The manifest's
`requiredClaimV1AppVersion` and `requiredRuntimeVersion` values are hard
compatibility requirements, not observations of an installed App. Mobile
acceptance remains blocked until an authenticated, operator-trusted channel
actually provides those versions and a real device passes pairing.

An authenticated mobile release pipeline may instead use the retained signed
channel contract: Android may use a signed Play Store AAB and, when explicitly
authorized, a signed direct-install APK; iOS may use App Store, TestFlight, or
managed-device delivery. An IPA is never a universal sideload artifact. Only
that signed mode accepts build/signing/artifact receipts.

Pairing uses a short-lived, one-time claim link containing only the fixed
`v=claim-v1` discriminator, an exact claim ID, and the HTTPS Relay origin. It must not expose the account token, Relay
master secret, or a reusable pairing secret. Treat the pairing contract as
source-implemented only after both the Relay endpoint and installed App version
have passed the claim-v1 integration tests, and field-verified only after a real
phone build completes a desktop-to-phone scan. Legacy endpoints remain
available for old client flows, but a current Relay emits claim-v1 and an old
phone App cannot parse that QR. It must be upgraded. The current Add Phone
screen has no force-legacy control; do not document or rely on one unless it is
implemented and separately reviewed.

## Upgrade and rollback

Perform upgrades in a maintenance window with a single proven writer.

Before upgrading the Controller, stop normal writes and create an offline,
access-control-preserving snapshot of the complete Relay state:

- SQLite database, WAL, and SHM files;
- uploaded/local files;
- master secret material;
- effective configuration and service definition.

The current CLI command `happier relay host snapshot --preflight` only checks
the stopped-writer and source-coverage boundary. It intentionally returns
`BLOCKED`: the project has not yet verified a cross-platform backend that
preserves Windows ACLs or POSIX ACL/xattr/ownership, produces a trusted digest,
and passes a restore rehearsal. Use a separately validated operator backup
procedure; never treat preflight output as a completed backup.

The existing runtime installer may restore binaries and service metadata after
an installation failure, but that is not a database rollback. Forward schema
migrations can make an old binary incompatible with new data. Restoring data is
a separate destructive operation requiring explicit authorization and proof
that no writer is active.

Agent upgrades and rollbacks must continue to use the existing versioned
component installer and daemon-service owner. Do not add `current`, `previous`,
or service-switch logic to the deployment-kit assembler.

## Acceptance gates

A deployment is complete only when all relevant gates pass on the destination:

- included artifact target, digest, signature/receipt when applicable, and version lock;
- for `external-app`, independent availability of the required claim-v1 App/runtime versions and a real-device pairing result; until then mobile acceptance is blocked;
- exactly one Controller Relay writer and the intended Agent daemons;
- Relay bound only to loopback before the private HTTPS gateway;
- HTTPS UI, API, and Socket.IO/Engine.IO health;
- Funnel and unintended LAN/public exposure absent;
- intended account, owner, Codex home, and real session identity;
- Direct and Takeover behavior for local and SSH sessions;
- send, approve, interrupt, resume, and reconnect behavior;
- one real mobile send renders once, while two intentional identical sends
  render twice;
- upgrade snapshot and rollback procedure rehearsed on non-production data.

Source tests and a locally assembled kit are not substitutes for real multi-OS,
SSH, Android, and iOS acceptance. Record those results separately for each
released version.
