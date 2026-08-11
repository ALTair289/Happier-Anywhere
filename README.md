# Happier Anywhere

[简体中文](README.zh-CN.md) · [Upstream Happier](https://github.com/happier-dev/happier) · [Deployment repository](https://github.com/ALTair289/Happier-Anywhere)

Happier Anywhere is a multi-platform source and deployment project for using your coding agents from wherever you are. It connects local and SSH-hosted Codex, Claude Code, and other supported agents to the Happier Web, Desktop, and mobile applications, so you can inspect work, send instructions, approve actions, interrupt or resume a task, and take control of an existing session without staying in front of the original terminal.

Happier Anywhere is built on [Happier](https://github.com/happier-dev/happier). This repository preserves Happier's source history and MIT license while adding the deployment, remote-machine, session-ownership, release, and security work needed for the Happier Anywhere workflow. See [NOTICE](NOTICE), [UPSTREAM.md](UPSTREAM.md), and [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json) for provenance details.

## Repository map

| Repository | Purpose |
| --- | --- |
| [Happier Anywhere Source](https://github.com/ALTair289/Happier-Anywhere-Source) | Full source, tests, build scripts, protocol, CLI, server, UI, and deployment pipeline |
| [Happier Anywhere](https://github.com/ALTair289/Happier-Anywhere) | Lightweight installation project, release manifests, checksums, signatures, and operator documentation |
| [happier-dev/happier](https://github.com/happier-dev/happier) | Upstream Happier project and application ecosystem |

## What it provides

- Access through the Happier mobile app, Desktop app, or a browser.
- A controller that can manage agents running on the same machine or on remote machines over SSH.
- Windows x64, Linux x64/ARM64, and macOS Intel/Apple Silicon deployment targets.
- Real session discovery instead of synthetic demo sessions.
- Viewing, messaging, approval, interruption, resume, and controlled session takeover.
- A loopback-only Relay design that can be exposed privately through an authenticated HTTPS gateway such as Tailscale Serve.
- Reproducible release manifests, checksums, Minisign verification, provenance records, and secret scanning.

The intended topology is:

```text
Happier App / Desktop / Web
            │ HTTPS
            ▼
Private gateway (for example Tailscale Serve)
            │
            ▼
Relay on 127.0.0.1:3005
            │
     Controller daemon
       ┌────┴───────────────┐
       ▼                    ▼
Local coding agents    SSH-connected machines
                            │
                            ▼
                    Codex / Claude Code / others
```

## Project status

The active reviewed integration candidate is the `codex/ha-integration` branch. Use signed release artifacts for stable deployments when they are published. Until that branch is merged, source users should explicitly select it rather than assuming that `dev` contains the same changes.

## Quick start from source

### Prerequisites

- Git.
- A current Node.js release compatible with the repository and Corepack.
- Yarn 1.22.22, as pinned by `packageManager`.
- At least one supported provider CLI, such as Codex or Claude Code.
- SSH for remote-machine control.
- Optional: Docker for a containerized Relay and Tailscale for private HTTPS access.

### Clone and build

```bash
git clone https://github.com/ALTair289/Happier-Anywhere-Source.git
cd Happier-Anywhere-Source
git switch codex/ha-integration

corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
yarn build
```

After the integration branch is merged, use the repository's default development branch instead.

### Start the guided local environment

```bash
yarn tui
```

The TUI is the easiest source-development entry point. It guides you through the local server, CLI, UI, authentication, and service state.

For the background development stack:

```bash
yarn dev
```

Stop repository-managed background processes with:

```bash
yarn stop
```

### Activate and authenticate the CLI

```bash
yarn cli:activate
happier auth login
```

Then start a provider through Happier, for example:

```bash
happier codex
```

Provider-specific commands and available capabilities may differ. Check the CLI help before automating them:

```bash
happier --help
```

## Using the Happier app, Desktop, and Web

Happier Anywhere uses the Happier client experience. Install a current Happier client from the [upstream Happier project](https://github.com/happier-dev/happier), or run the UI from this source repository:

```bash
yarn ui:web
yarn ui:ios
yarn ui:android
yarn ui:tauri
```

Only one UI target is needed. Sign in with the account connected to your Relay, then choose the intended machine and session. The native app and browser use the same authenticated session model; the app is not a secondary or reduced-control client.

For a self-hosted Relay, configure the client with its HTTPS address. Do not place tokens, passwords, or pairing secrets directly in shell history, screenshots, issue reports, or URLs.

## Deploying the controller

The controller owns the Relay connection and coordinates local or SSH-connected machines.

For a user-level service:

```bash
yarn service:install:user
yarn service:status
```

A system-level installation is also available:

```bash
yarn service:install:system
```

System service installation may require administrator or root approval. Prefer a user service unless the machine must operate before user login or your deployment policy requires a system service.

The Relay should listen on loopback only. Verify local health before publishing any HTTPS route. The recommended private exposure is Tailscale Serve; Funnel and plaintext LAN publishing are intentionally excluded from the default security model.

See [Deployment kit](docs/deployment-kit.md), [Deployment architecture](docs/deployment.md), and [Mobile deployment](docs/deployment-kit-mobile.md) for the complete controller workflow.

## Adding another computer

An agent machine runs the Happier CLI/daemon and connects to the controller's Relay. The same model applies to Windows, Linux, and macOS:

1. Install a verified Happier Anywhere release or build this source tree.
2. Configure the Relay HTTPS address.
3. Authenticate the intended user/account.
4. Install the user-level daemon or service.
5. Confirm the exact machine identity and that only one session writer is active.
6. Start or discover the provider session from the Happier app, Desktop, or Web.

The deployment kit currently defines these canonical targets:

- `windows-x64`
- `linux-x64-glibc`
- `linux-arm64-glibc`
- `darwin-x64`
- `darwin-arm64`

Use [Happier Anywhere](https://github.com/ALTair289/Happier-Anywhere) for the lightweight installer and signed release workflow. Use this source repository when developing, auditing, or producing your own verified build.

## Connecting SSH machines

From the controller, the guided deployment flow can configure a remote machine over SSH:

```bash
happier machine setup --ssh <user@host>
```

The SSH configuration can use an explicit config file, aliases, custom host names and ports, and IPv6. Endpoint resolution is shared across host trust, SSH, and SCP. If the effective configuration changes during an operation, the operation fails closed. Proxy-based routes that cannot be verified safely by the key-discovery path must be handled explicitly rather than silently bypassed.

Before accepting a remote machine, verify:

- The resolved host and account are the intended endpoint.
- Host-key trust was established through the approved route.
- The remote daemon owns the expected `CODEX_HOME` or provider state.
- No second daemon or terminal writer is modifying the same session.

## Existing sessions and takeover modes

Happier Anywhere distinguishes three session behaviors:

| Mode | Behavior |
| --- | --- |
| **Direct** | Keeps the provider transcript on its owning machine as the source of truth. The session may initially be observe-only, and it is unavailable while that machine is offline. A `Direct` label by itself does not prove that control has transferred. |
| **Take over** | Transfers control to Happier without importing the provider transcript. It must occur at an idle turn boundary with the exact session, owner, and cursor confirmed. |
| **Take over + import** | Transfers control and imports prior history into Happier. The import must preserve the existing history as an unchanged prefix and append without duplicates, gaps, or overwrite. |

Takeover is deliberately conservative. Stop if the session has an active tool call, pending writer, ambiguous owner, duplicate daemon, conflict prompt, or unknown synchronization state.

## Security baseline

- Bind the Relay to `127.0.0.1`, not `0.0.0.0`.
- Expose it through authenticated HTTPS, preferably a private Tailscale Serve route.
- Keep Tailscale Funnel and public ingress disabled unless a separate threat model explicitly permits them.
- Keep Windows Containers and unrelated machine-level services disabled when using the WSL2 deployment path.
- Verify release checksums, Minisign signatures, platform metadata, and non-root container metadata before installation.
- Never print or commit tokens, pairing claims, private keys, environment dumps, or credential-bearing URLs.
- Maintain one authoritative writer for each provider session.
- Treat restart, privilege escalation, destructive cleanup, backend changes, and machine-level services as explicit approval boundaries.

Report security issues through [SECURITY.md](SECURITY.md). Supply-chain and artifact rules are documented in [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md).

## Common commands

| Command | Purpose |
| --- | --- |
| `yarn tui` | Start the guided local development console |
| `yarn dev` | Start the background development stack |
| `yarn stop` | Stop repository-managed background processes |
| `yarn cli:activate` | Activate the locally built CLI |
| `yarn auth` | Run the repository authentication helper |
| `yarn daemon` | Run the daemon workspace command |
| `yarn server:light` | Start the lightweight server development mode |
| `yarn ui:web` | Run the Web client |
| `yarn ui:tauri` | Run the Desktop client |
| `yarn service:status` | Inspect the installed service |
| `yarn tailscale:status` | Inspect Tailscale-related repository state |
| `yarn typecheck` | Type-check all workspaces |
| `yarn test` | Run the repository test suite |
| `yarn scan:source:filenames` | Scan source paths for secret-like names |
| `yarn scan:source:secrets` | Run the redacted source secret scan |

## Development and verification

Run focused checks while developing, then the wider checks before publishing:

```bash
yarn typecheck
yarn test
yarn test:integration
yarn scan:source:filenames
yarn scan:source:secrets
```

Release builders must preserve the complete five-platform catalog. A verified deployment catalog cannot omit a target or a required controller/agent role. Release evidence, checksums, signatures, and source provenance must refer to the same exact commit and assets.

Useful technical references:

- [Documentation index](docs/README.md)
- [CLI architecture](docs/cli-architecture.md)
- [Codex feature matrix](docs/codex-feature-matrix.md)
- [Binary runtime](docs/binary-runtime.md)
- [Release process](docs/release-process.md)
- [Pending delivery model](docs/pending-delivery.md)

## Contributing and upstream sync

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Keep Happier Anywhere-specific work reviewable and preserve upstream history so future Happier updates can be audited and merged cleanly. Upstream synchronization and provenance rules are described in [UPSTREAM.md](UPSTREAM.md).

## License

Licensed under the MIT License. See [LICENCE](LICENCE) and [NOTICE](NOTICE).
