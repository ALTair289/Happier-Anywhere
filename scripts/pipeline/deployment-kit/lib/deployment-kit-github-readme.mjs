// @ts-check

const UPSTREAM_HAPPIER_URL = 'https://github.com/happier-dev/happier';

function projectUrl(catalog) {
  return `https://github.com/${catalog.repository.slug}`;
}

function repositoryName(catalog) {
  return catalog.repository.slug.split('/')[1];
}

function targetList(catalog) {
  return [...new Set(catalog.artifacts.map((artifact) => artifact.targetId))]
    .sort()
    .map((target) => `\`${target}\``)
    .join(', ');
}

function platformName(target, language) {
  const names = language === 'zh'
    ? { windows: 'Windows', linux: 'Linux', darwin: 'macOS' }
    : { windows: 'Windows', linux: 'Linux', darwin: 'macOS' };
  const osName = names[target.os] ?? target.os;
  const archName = target.arch === 'x64' ? 'x64' : target.arch === 'arm64' ? 'arm64' : target.arch;
  const libc = target.os === 'linux' && target.libc ? ` / ${target.libc}` : '';
  return `${osName} ${archName}${libc}`;
}

function supportedPlatformTable(catalog, language) {
  const targets = new Map();
  for (const artifact of catalog.artifacts) {
    const row = targets.get(artifact.targetId) ?? {
      targetId: artifact.targetId,
      target: artifact.target,
      agent: false,
      controller: false,
    };
    if (artifact.role === 'agent') row.agent = true;
    if (artifact.role === 'controller') row.controller = true;
    targets.set(artifact.targetId, row);
  }

  const header = language === 'zh'
    ? '| 平台 | 目标 ID | 运行会话 | 运行 Relay |\n| --- | --- | :---: | :---: |'
    : '| Platform | Target ID | Run sessions | Run the Relay |\n| --- | --- | :---: | :---: |';
  const yes = language === 'zh' ? '支持' : 'Yes';
  const no = language === 'zh' ? '—' : '—';
  const rows = [...targets.values()]
    .sort((a, b) => a.targetId.localeCompare(b.targetId))
    .map((entry) => `| ${platformName(entry.target, language)} | \`${entry.targetId}\` | ${entry.agent ? yes : no} | ${entry.controller ? yes : no} |`);
  return [header, ...rows].join('\n');
}

function archiveStem(assetName) {
  return assetName.endsWith('.tar.gz') ? assetName.slice(0, -'.tar.gz'.length) : assetName;
}

function artifactInventory(catalog, language) {
  const header = language === 'zh'
    ? '| 角色 | 目标 | Release 归档 | 解压根目录内的可执行文件 |\n| --- | --- | --- | --- |'
    : '| Role | Target | Release archive | Executable inside extracted root |\n| --- | --- | --- | --- |';
  const rows = catalog.artifacts.map((artifact) => {
    const executable = artifact.role === 'controller'
      ? `happier-server${artifact.target.os === 'windows' ? '.exe' : ''}`
      : `happier${artifact.target.os === 'windows' ? '.exe' : ''}`;
    return `| \`${artifact.role}\` | \`${artifact.targetId}\` | \`${artifact.release.assetName}\` | \`${archiveStem(artifact.release.assetName)}/${executable}\` |`;
  });
  return [header, ...rows].join('\n');
}

function englishRepositoryAvailability(catalog) {
  if (catalog.repository.availability === 'verified') {
    return 'The catalog field `repository.availability` is `verified`: the referenced versioned tags and signed checksum receipts have been published and independently verified.';
  }
  return 'The catalog field `repository.availability` remains `not-verified` until the referenced versioned tags and signed checksum receipts have been published and independently verified.';
}

function englishSshReleaseGate(catalog) {
  const status = catalog.repository.availability === 'verified'
    ? '**Release gate:** `repository.availability` is `verified`.'
    : '**Release gate:** this procedure is not available while `repository.availability` is `not-verified`.';
  return `${status} Before using it, verify the exact published CLI asset selected by the catalog, and confirm that the asset's own \`machine setup --help\` advertises \`--cli-payload\` — support in a source workspace is not proof that a released binary contains the feature.`;
}

function chineseRepositoryAvailability(catalog) {
  if (catalog.repository.availability === 'verified') {
    return '目录字段 `repository.availability` 为 `verified`：所引用的版本化标签与签名校验清单已经发布，并已完成独立核验。';
  }
  return '在所引用的版本化标签与签名校验清单发布并完成独立核验之前，目录字段 `repository.availability` 会保持为 `not-verified`。';
}

function chineseSshReleaseGate(catalog) {
  const status = catalog.repository.availability === 'verified'
    ? '**Release 门禁：**`repository.availability` 已为 `verified`。'
    : '**Release 门禁：**当 `repository.availability` 仍为 `not-verified` 时，此流程不可用。';
  return `${status} 执行前必须验证目录选中的精确已发布 CLI 资产，并由该二进制自身的 \`machine setup --help\` 确认包含 \`--cli-payload\`——源码工作区支持该参数，不等于已发布二进制已经支持。`;
}

// ===== English landing page (README.md) =====

function englishAvailabilityWarning(catalog) {
  if (catalog.repository.availability === 'verified') {
    return '> **Release status:** the versioned downloads referenced by this project are available. The included fetch scripts still verify every file before staging it.';
  }
  return '> **Release status:** this project is still being prepared. Its versioned downloads must not be treated as available until `catalog.json` reports `repository.availability: verified`.';
}

function englishLanding(catalog) {
  return `# Happier Anywhere

[English](README.md) | [简体中文](README.zh-CN.md)

**Bring the Codex and Claude Code sessions running on your computers and servers to your phone, browser, and the Happier App.**

One private Relay connects the machines you choose. Your coding agents keep running where their projects live, while you can follow progress, send instructions, handle approvals, interrupt a run, or take over from another device.

## What is Happier Anywhere?

[Happier](${UPSTREAM_HAPPIER_URL}) is an open-source, end-to-end encrypted companion for AI coding agents. Happier Anywhere provides a ready-to-deploy self-hosted setup for Windows, Linux, and macOS, including remote Linux or macOS hosts added over SSH.

This repository contains the deployment catalog and setup helpers. Native packages stay in versioned Releases, so each machine downloads only the package for its own platform and role.

## Quick start

${englishAvailabilityWarning(catalog)}

\`\`\`bash
git clone ${projectUrl(catalog)}.git
cd ${repositoryName(catalog)}
\`\`\`

Choose the Controller's target ID from [Supported platforms](#supported-platforms), replace the placeholder, and preview the download:

\`\`\`bash
TARGET_ID='<target-id-from-the-table>'
bash scripts/fetch.sh --plan --role controller --target "$TARGET_ID"
\`\`\`

\`\`\`powershell
$TargetId = '<target-id-from-the-table>'
.\\scripts\\fetch.ps1 -Plan -Role controller -TargetId $TargetId
\`\`\`

Then:

1. Pick one trusted computer to run the Relay.
2. Review the plan. It shows what would be downloaded without installing anything.
3. Follow the [deployment guide](docs/DEPLOYMENT.md) to download and install the Relay, connect with private HTTPS, and add the computers or SSH hosts where your coding sessions run.
4. Open the private URL in a browser or add it to the Happier App.

The guide provides copyable PowerShell commands for Windows and shell commands for Linux and macOS. It also explains every verification step before anything is installed.

## Use it from your phone or browser

Your projects and provider CLIs stay on their original machines. Happier gives you another place to see and control the sessions running there.

- **Happier App:** use the native iOS or Android app and add your private Relay.
- **Browser:** open the same private HTTPS address from a device on your tailnet. No browser extension or PWA installation is required.
- **Desktop:** use the browser or upstream Happier's desktop client where available.

Mobile apps are distributed by upstream Happier and are not bundled in this repository:

| Platform | Get the App |
| --- | --- |
| iPhone / iPad | [App Store](https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758554297) |
| Android (Play Store) | Private beta: join the [Happier Google Group](https://groups.google.com/g/happier-dev), then join [from Android](https://play.google.com/store/apps/details?id=dev.happier.app) or [from the web](https://play.google.com/apps/testing/dev.happier.app) |
| Android (direct) | [Happier preview APK](https://github.com/happier-dev/happier/releases/download/ui-mobile-preview/happier-preview.apk) |

After the Relay is installed, add its private HTTPS URL to the App and sign in with the same Happier account used by your connected machines.

## What you can do

- Follow live Codex and Claude Code sessions without staying at the terminal.
- Send instructions, answer approval requests, interrupt work, and resume later.
- Take over an existing supported session without starting it again.
- See sessions from several computers and SSH hosts in one place.
- Use the same deployment from the Happier App, a browser, or a desktop client.
- Keep the Relay under your control and expose it only through private HTTPS.

## How it fits together

One trusted computer runs the Relay. Every computer that runs coding sessions connects to it in the background. The App and browser reach the Relay through private HTTPS.

\`\`\`text
Browser / Happier App
        |
        | private HTTPS (recommended: Tailscale Serve; Funnel stays off)
        v
Controller: Relay on 127.0.0.1:3005
        |
        +-- sessions on the Controller itself
        +-- sessions on other computers you have added
        +-- sessions on Linux/macOS hosts installed over SSH
\`\`\`

| Role | Where it runs | What it does |
| --- | --- | --- |
| Controller | One trusted computer, usually left on | Runs the private Relay. |
| Agent | Any computer running your coding tools | Makes that computer's sessions available through the Relay. |
| SSH Agent | A Linux or macOS host | The same Agent, installed from the Controller over SSH. |

You need only one Controller. SSH hosts run an Agent, not another Relay.

## Supported platforms

${supportedPlatformTable(catalog, 'en')}

Only the targets listed above are referenced by this generated project. Linux and macOS Agents can also be installed over SSH; the remote host still runs sessions only.

## Private by default

- Happier encrypts session content end to end.
- The Relay listens on \`127.0.0.1:3005\`, not on the LAN.
- Tailscale Serve is the recommended private HTTPS gateway; Funnel remains off.
- Download helpers require the expected signature, SHA-256, and file size before staging a package.
- Credentials, pairing links, private keys, and Relay data do not belong in this repository or its support output.

Read the full [security checklist](docs/DEPLOYMENT.md#security-checklist) before exposing the Relay or installing on another machine.

## Documentation

- [Install and operate Happier Anywhere](docs/DEPLOYMENT.md) · [简体中文](docs/DEPLOYMENT.zh-CN.md)
- [Upstream Happier documentation](https://docs.happier.dev/getting-started/onboarding)
- [Upstream Happier repository](${UPSTREAM_HAPPIER_URL})
- [Happier community on Discord](https://discord.gg/W6Pb8KuHfg)

## Built with Happier

Happier Anywhere is a deployment companion for [Happier](${UPSTREAM_HAPPIER_URL}), not a replacement for the upstream project. The generated repository keeps Happier's MIT license unchanged in [LICENCE](LICENCE).`;
}

// ===== English operator guide (docs/DEPLOYMENT.md) =====

function englishGuideIntro() {
  return `# Deployment guide — Happier Anywhere

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md) · back to [README](../README.md)

This guide is the operator manual for a Happier Anywhere deployment. It covers
verifying and downloading the exact published artifacts, installing the private
Relay and the machines that connect to it, day-to-day operations, upgrades, and
troubleshooting. The landing page ([README](../README.md)) explains the model
in plain language; this document keeps the precise, safety-critical details.`;
}

function englishGuideScope() {
  return `## What this repository includes and excludes

Included: an asset catalog (hashes cross-checked against Minisign-signed component checksum receipts), PowerShell and POSIX download verifiers, role-specific bootstrap scripts, the deployment schema, an integrity receipt, and CI verification. Not included: native archives, mobile applications, credentials, tokens, private keys, Relay data, or a public Internet gateway. This repository does not install prerequisites, elevate privileges, change a firewall/router, configure Tailscale, reboot a machine, or silently accept host-trust prompts.`;
}

function englishGuidePrerequisites() {
  return `## Prerequisites

- Git, \`tar\`, \`curl\` (for the Bash downloader), and [Minisign](https://jedisct1.github.io/minisign/). Windows examples require PowerShell 5.1 or later.
- Enough disk space for just the selected native archives and extracted payloads. The destination directory must not already exist.
- Codex, Claude Code, or another supported provider CLI, installed and authenticated as the same operating-system user that will run the Happier Agent.
- For SSH setup: working key-based or interactive SSH access, a reviewed host identity, and an extracted Agent payload matching the remote OS and architecture.
- A private HTTPS route to the Relay. Tailscale Serve is recommended; do not use Tailscale Funnel or expose the Relay as plaintext on the LAN.
- Before upgrades, a tested backup process for Relay data and secrets that preserves ACLs.`;
}

function englishGuideVerifyReleases(catalog) {
  const totalBytes = catalog.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  return `## Clone the repository and verify GitHub Releases

\`\`\`bash
git clone ${projectUrl(catalog)}.git
cd ${repositoryName(catalog)}
\`\`\`

Before downloading anything, inspect \`catalog.json\`, \`assets.tsv\`, \`happier-release.pub\`, and \`PROJECT-SHA256SUMS\`. The component release tags are \`cli-v${catalog.compatibility.cli}\` and \`server-v${catalog.compatibility.relay}\`. Git tags and release URLs alone are not sufficient integrity evidence: the helpers require the HTTPS connection, the Minisign-signed checksum receipt, the catalog SHA-256, and the declared byte size to agree.

${englishRepositoryAvailability(catalog)}

The inventory below is rendered directly from the catalog: ${catalog.artifacts.length} checksum-pinned assets (${totalBytes} bytes in total), supported target IDs ${targetList(catalog)}. Use the exact archive names and extracted-root executables it lists instead of guessing platform paths.

${artifactInventory(catalog, 'en')}`;
}

function englishGuideDownload() {
  return `## Select and download only what this machine needs

Always run the plan first to review what would be downloaded and staged. A Controller selection downloads the Agent CLI plus the Relay for the same target; Agent and SSH Agent selections download only the Agent CLI.

Windows Controller:

\`\`\`powershell
.\\scripts\\fetch.ps1 -Plan -Role controller -TargetId windows-x64
.\\scripts\\fetch.ps1 -Role controller -TargetId windows-x64 -OutDir .\\downloads\\controller
\`\`\`

Linux x64 local Agent:

\`\`\`bash
bash scripts/fetch.sh --plan --role agent --target linux-x64-glibc
bash scripts/fetch.sh --role agent --target linux-x64-glibc --out ./downloads/agent
\`\`\`

Linux x64 payload for an SSH Agent:

\`\`\`bash
bash scripts/fetch.sh --plan --role ssh-agent --target linux-x64-glibc
bash scripts/fetch.sh --role ssh-agent --target linux-x64-glibc --out ./downloads/ssh-agent
\`\`\`

Do not bypass any signature, hash, size, HTTPS, path, or existing-output failure. The fetch helpers stage only archives that pass every check; they never install or run them.`;
}

function englishGuideExtract() {
  return `## Extract into a restricted staging directory

The uppercase names in the commands below are deliberate placeholders: replace each with the exact archive and extracted-root names from the inventory above.

Windows Controller (Agent CLI plus Relay):

\`\`\`powershell
New-Item -ItemType Directory -Path .\\runtime\\controller-cli,.\\runtime\\controller-relay
tar.exe -xzf .\\downloads\\controller\\EXACT_AGENT_ARCHIVE_FROM_TABLE -C .\\runtime\\controller-cli
tar.exe -xzf .\\downloads\\controller\\EXACT_RELAY_ARCHIVE_FROM_TABLE -C .\\runtime\\controller-relay
\`\`\`

Windows local Agent only:

\`\`\`powershell
New-Item -ItemType Directory -Path .\\runtime\\agent
tar.exe -xzf .\\downloads\\agent\\EXACT_AGENT_ARCHIVE_FROM_TABLE -C .\\runtime\\agent
\`\`\`

Windows payload for an SSH Agent:

\`\`\`powershell
New-Item -ItemType Directory -Path .\\runtime\\ssh-agent
tar.exe -xzf .\\downloads\\ssh-agent\\EXACT_REMOTE_AGENT_ARCHIVE_FROM_TABLE -C .\\runtime\\ssh-agent
\`\`\`

POSIX Controller or Agent:

\`\`\`bash
mkdir -p runtime/controller-cli runtime/controller-relay runtime/agent runtime/ssh-agent
tar -xzf downloads/controller/EXACT_AGENT_ARCHIVE_FROM_TABLE -C runtime/controller-cli
tar -xzf downloads/controller/EXACT_RELAY_ARCHIVE_FROM_TABLE -C runtime/controller-relay
tar -xzf downloads/agent/EXACT_AGENT_ARCHIVE_FROM_TABLE -C runtime/agent
tar -xzf downloads/ssh-agent/EXACT_REMOTE_AGENT_ARCHIVE_FROM_TABLE -C runtime/ssh-agent
\`\`\`

After extraction, confirm that the expected executable from the table is a regular file and set its executable bit on POSIX systems; reject symlinks or reparse points in executable and payload paths. Hand bootstrap scripts the extracted binaries or the extracted payload root — never an archive path.

From here on, the examples refer to that exact verified path as \`HAPPIER_BIN\`/\`$HappierBin\`. The bootstrap scripts do not add the CLI to \`PATH\`.`;
}

function englishGuideController() {
  return `## Install the Controller

Use one machine as the Controller: the bootstrap delegates ownership to the canonical Happier CLI, installs a per-user Relay host, and fixes its listener to \`127.0.0.1:3005\`.

Windows PowerShell:

\`\`\`powershell
$HappierBin = (Resolve-Path '.\\runtime\\controller-cli\\EXACT_AGENT_EXTRACTED_ROOT\\happier.exe').Path
$RelayBin = (Resolve-Path '.\\runtime\\controller-relay\\EXACT_RELAY_EXTRACTED_ROOT\\happier-server.exe').Path
.\\bootstrap\\controller.ps1 -HappierBinary $HappierBin -ServerBinary $RelayBin
\`\`\`

Linux/macOS:

\`\`\`bash
HAPPIER_BIN=/absolute/path/to/runtime/controller-cli/EXACT_AGENT_EXTRACTED_ROOT/happier
RELAY_BIN=/absolute/path/to/runtime/controller-relay/EXACT_RELAY_EXTRACTED_ROOT/happier-server
bash bootstrap/controller.sh "$HAPPIER_BIN" "$RELAY_BIN"
\`\`\`

The script's protected invocation is equivalent to \`happier relay host install --server-binary ... --host 127.0.0.1 --mode user --yes --json --env PORT=3005\`. It rejects \`HAPPIER_BOOTSTRAP_RELAY_PORT\`; if port 3005 is already occupied, stop and identify the owner. Do not switch to a wildcard listener or choose another port simply to continue.

Verify locally before adding any HTTPS route:

\`\`\`powershell
& $HappierBin relay host status --mode user --json
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/ready
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/v1/features
$EngineIo = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3005/v1/updates/?EIO=4&transport=polling').Content
if (-not $EngineIo.StartsWith('0')) { throw 'Engine.IO handshake failed.' }
\`\`\`

\`\`\`bash
"$HAPPIER_BIN" relay host status --mode user --json
curl --fail http://127.0.0.1:3005/health
curl --fail http://127.0.0.1:3005/ready
curl --fail http://127.0.0.1:3005/v1/features
engine_io="$(curl --fail 'http://127.0.0.1:3005/v1/updates/?EIO=4&transport=polling')"
case "$engine_io" in 0*) ;; *) echo 'Engine.IO handshake failed.' >&2; exit 1 ;; esac
\`\`\`

Do not launch the server binary directly: its generic API default may listen on all interfaces. Use the canonical \`happier relay host install\` flow so the loopback policy is explicit and auditable.`;
}

function englishGuideTailscale() {
  return `## Add private HTTPS with Tailscale Serve

First inspect existing state and preserve unrelated configuration:

\`\`\`bash
tailscale serve status --json
tailscale funnel status
\`\`\`

If \`tailscale serve status --json\` returns anything other than an empty JSON object (\`{}\`) — especially if HTTPS \`:443\` or the root path is already taken — stop and review or merge the configuration manually. The command below assumes an empty, conflict-free baseline and must not overwrite unrelated Serve configuration.

With loopback HTTP and realtime/Engine.IO health checks confirmed good, configure a private tailnet endpoint:

\`\`\`bash
tailscale serve --bg --https=443 http://127.0.0.1:3005
tailscale serve status --json
tailscale funnel status
\`\`\`

Use the HTTPS \`*.ts.net\` URL reported by Tailscale as both the Relay and Web App origin, and keep Funnel disabled. Never publish a Docker or native Relay on \`0.0.0.0\`, expose port 3005 directly to the LAN, create a plaintext gateway, or change router or firewall policy as part of this guide.`;
}

function englishGuideAgent() {
  return `## Install a local Agent

Install an Agent on the Controller too if it owns local Codex/Claude sessions, and on every additional computer whose sessions should appear in Happier.

Windows:

\`\`\`powershell
$HappierBin = (Resolve-Path '.\\runtime\\agent\\EXACT_AGENT_EXTRACTED_ROOT\\happier.exe').Path
.\\bootstrap\\agent.ps1 -HappierBinary $HappierBin -ServerUrl https://your-private-name.ts.net
\`\`\`

Linux/macOS:

\`\`\`bash
HAPPIER_BIN=/absolute/path/to/runtime/agent/EXACT_AGENT_EXTRACTED_ROOT/happier
bash bootstrap/agent.sh "$HAPPIER_BIN" https://your-private-name.ts.net
\`\`\`

The bootstrap runs the canonical sequence \`server set\`, \`auth login --no-open ... --persist\`, \`service install --mode user --yes --json\`. Complete the displayed login/pairing flow yourself — never paste a token into a script, repository, shell history, or support log.

Verify the per-user owner:

\`\`\`powershell
& $HappierBin service status --mode user --json
& $HappierBin daemon status --json
\`\`\`

\`\`\`bash
"$HAPPIER_BIN" service status --mode user --json
"$HAPPIER_BIN" daemon status --json
\`\`\`

There must be exactly one effective daemon/writer per Agent identity; stop if you find duplicate services, ambiguous ownership, an unexpected Relay URL, or an authentication mismatch.`;
}

function englishGuideSshAgent(catalog) {
  return `## Install an Agent through SSH

${englishSshReleaseGate(catalog)}

Download and extract the Agent archive for the **remote** platform, then run the SSH bootstrap from the Controller. \`CliPayload\` must be the extracted payload root — not the archive, and not the Controller's own payload.

Windows Controller to Linux/macOS target:

\`\`\`powershell
$HappierBin = (Resolve-Path '.\\runtime\\controller-cli\\EXACT_AGENT_EXTRACTED_ROOT\\happier.exe').Path
$RemotePayload = (Resolve-Path '.\\runtime\\ssh-agent\\EXACT_REMOTE_AGENT_EXTRACTED_ROOT').Path
.\\bootstrap\\ssh-agent.ps1 -HappierBinary $HappierBin -SshTarget user@remote-host -CliPayload $RemotePayload -ServerUrl https://your-private-name.ts.net
\`\`\`

Linux/macOS Controller:

\`\`\`bash
HAPPIER_BIN=/absolute/path/to/runtime/controller-cli/EXACT_AGENT_EXTRACTED_ROOT/happier
REMOTE_PAYLOAD=/absolute/path/to/runtime/ssh-agent/EXACT_REMOTE_AGENT_EXTRACTED_ROOT
bash bootstrap/ssh-agent.sh "$HAPPIER_BIN" user@remote-host "$REMOTE_PAYLOAD" https://your-private-name.ts.net
\`\`\`

The script calls \`happier machine setup --ssh ... --cli-payload ... --server-url ... --webapp-url ...\`. Omit \`-Yes\` or \`--yes\` on the first run so you can review the host-trust and pairing prompts. The canonical machine owner validates platform compatibility, transfers the payload through its own SSH/SCP corridor, authenticates, and owns the remote daemon installation — do not create a second ad-hoc systemd or launchd service.

A desktop Codex client that controls an SSH terminal does **not** automatically make the remote session visible to Happier: the SSH host needs its own linked Happier Agent, and only sessions the provider integration can safely identify/link are eligible.`;
}

function englishGuideFirstUse() {
  return `## First use from a browser or the Happier App

1. Connect the phone/tablet/computer to the same tailnet and open the private HTTPS Relay URL in a browser.
2. Create or sign in to the intended Happier account and finish the current authenticated pairing/claim flow.
3. For Android/iOS, obtain the native [Happier App from upstream Happier](${UPSTREAM_HAPPIER_URL}) through an operator-trusted official channel, then connect it to the same private HTTPS origin and account. This repository does not include, re-sign, or independently certify mobile binaries.
4. Confirm the expected Agent, operating-system user, provider identity, and session owner before sending a command.
5. Start a new managed session by invoking the verified \`HAPPIER_BIN\` with no subcommand on the Agent host, or use an existing session only when Happier explicitly shows it as safely linked.

The Web UI and native App can show progress, send instructions, approve supported actions, interrupt or stop work, resume stopped work, and run supported takeover flows. What is available depends on the provider and session type — a visible button is not proof that ownership transferred successfully.

The embedded Web UI is served through the same private HTTPS Relay origin; this kit makes no browser-install or offline-cache claims.

Do not treat the App and runtime version fields in the catalog as proof that a store or MDM channel has published those versions: mobile acceptance remains blocked until an operator-trusted channel actually provides the declared versions and a real device passes pairing.

### Direct, Take over, and Take over + import

The definitions below are operational meanings — use them **only if the installed upstream Happier App and the selected provider/session actually expose these controls**. Happier Anywhere does not implement or enable them, and labels and capabilities can differ between Happier releases.

- **Direct** keeps the provider transcript on the owning machine as the source of truth; the session may be observe-only until Happier takes control, and it is unavailable while that machine is offline. A persistent “Direct” label is not proof of takeover.
- **Take over** lets Happier control the session without importing its transcript — the session stays Direct and provider-backed. Do it only at an idle, safe-turn boundary, after checking the exact session ID, owner, and cursor and confirming that no tool call or pending writer remains.
- **Take over + import** imports the transcript into Happier, switches the session to persisted Happier storage, and continues with full supported Happier session features. Before choosing it, note the visible history boundary; afterward, check for gaps or duplicate messages and stop at any conflict or overwrite warning.
- Never let two daemons, terminals, or devices write the same session concurrently. A harmless read-only acknowledgement is the safest first post-takeover check.

### CLI usage

The example below is POSIX. In PowerShell, use \`& $HappierBin\` followed by the same arguments.

\`\`\`bash
# Start a new provider session interactively
"$HAPPIER_BIN"

# Discover and inspect sessions
"$HAPPIER_BIN" session list --active
"$HAPPIER_BIN" session status <session-id> --live

# Send one instruction and wait for the result
"$HAPPIER_BIN" session send <session-id> "summarize current status only" --wait

# Stop, resume, or attach
"$HAPPIER_BIN" session stop <session-id>
"$HAPPIER_BIN" resume <session-id>
"$HAPPIER_BIN" attach <session-id>
\`\`\`

Use full IDs when similarly prefixed sessions exist. Confirm identity and owner again before approval, interruption, resume, or takeover.`;
}

function englishGuideDailyOperations() {
  return `## Daily operations

| Goal | Command |
| --- | --- |
| Relay status | \`"$HAPPIER_BIN" relay host status --mode user --json\` |
| Relay start/stop/restart | \`"$HAPPIER_BIN" relay host start\\|stop\\|restart --mode user --json\` |
| Agent service status | \`"$HAPPIER_BIN" service status --mode user --json\` |
| Agent service start/stop/restart | \`"$HAPPIER_BIN" service start\\|stop\\|restart --mode user --json\` |
| Daemon status | \`"$HAPPIER_BIN" daemon status --json\` |
| Active sessions | \`"$HAPPIER_BIN" session list --active\` |
| Live session | \`"$HAPPIER_BIN" session status <id> --live\` |
| Private gateway | \`tailscale serve status --json\` |
| Public exposure negative check | \`tailscale funnel status\` |

Do not run provider and Happier service operations under a different OS account unless you intentionally migrate ownership and credentials.`;
}

function englishGuideUpgradeRollback() {
  return `## Upgrade and rollback

Plan the upgrade in a maintenance window with no active Relay writer. Stop the canonical Relay, take a full backup of its database (including SQLite WAL/SHM where applicable), files, configuration, master secret, and ACLs, and verify the backup. Download the newly versioned asset through the same signature/hash/size gates, then let the canonical service owner update it — never replace a live executable in place.

Rolling back the binary and rolling back data are different operations: reinstalling an older executable does not roll back a migrated database, and data restore requires a separately approved, tested procedure. After any change, recheck loopback health, HTTPS, Engine.IO/Socket.IO, one daemon/writer per Agent, Funnel disabled, and the absence of wildcard or public listeners.`;
}

function englishGuideTroubleshooting(catalog) {
  return `## Troubleshooting

| Symptom | Safe next check |
| --- | --- |
| Release URL is 404 / availability is \`not-verified\` | Confirm the exact versioned release/tag exists in [this repository](${projectUrl(catalog)}); do not substitute \`latest\` or an unsigned mirror. |
| \`minisign\` is missing | Install Minisign from a trusted package source, then rerun the plan/download; do not disable signature verification. |
| Signature/hash/size mismatch | Delete only the newly staged failed download, verify the trusted public key/catalog, and investigate provenance. |
| Port 3005 is busy | Identify the existing listener and stop. Do not switch to a wildcard or undocumented port override. |
| Private HTTPS is unavailable | Check local \`/health\` and \`/ready\`, then \`tailscale serve status --json\`; keep Funnel off. |
| Agent is offline | Use the verified CLI path to check \`service status --json\` and \`daemon status --json\`, then inspect the configured Relay URL, account, and tailnet reachability. |
| SSH setup fails | Recheck host identity, SSH access, remote OS/architecture, extracted payload root, and HTTPS URL. Do not hand-write a second daemon service. |
| Existing Codex session is missing | Verify that an Agent runs on the actual session host and user, then check provider session-link capability. An SSH terminal controlled elsewhere is not enough. |
| App appears to send the same message twice | Stop sending; verify one Agent/daemon/writer, exact session owner, pending-message reconciliation, and whether the duplicate is only a UI echo before retrying. |`;
}

function englishGuideSecurityChecklist() {
  return `## Security checklist

- Relay listens only on \`127.0.0.1:3005\`; private HTTPS terminates in Tailscale Serve or an equivalently authenticated gateway.
- Tailscale Funnel, public DNS exposure, plaintext LAN access, wildcard listeners, and direct Docker port publishing remain disabled.
- Release asset URL, Minisign signature, SHA-256, byte size, target, and extracted path all match the catalog.
- Credentials, tokens, pairing links, QR payloads, secrets, environment dumps, private keys, and Relay data never enter Git or support output.
- Service files and secrets are owned by the canonical per-user installer with restrictive ACLs.
- There is exactly one Relay writer and one daemon/writer per Agent identity.
- Takeover happens only at a verified idle boundary with exact identity/owner checks.
- Backups and rollback are tested before an upgrade.`;
}

function englishGuideRepositoryMap(catalog) {
  return `## Repository map

| Path | Purpose |
| --- | --- |
| \`catalog.json\` / \`deployment-catalog.schema.json\` | Machine-readable roles, targets, versions, URLs, hashes, sizes, and schema. |
| \`assets.tsv\` | Human-auditable asset index. |
| \`happier-release.pub\` | Minisign public key used for component checksum receipts. |
| \`LICENCE\` | Unmodified upstream Happier root MIT license and copyright notice. |
| \`scripts/fetch.ps1\`, \`scripts/fetch.sh\` | Plan and stage only the selected verified native archives. |
| \`bootstrap/controller.*\` | Install the loopback-only Relay through the canonical Happier owner. |
| \`bootstrap/agent.*\` | Configure/authenticate/install a local per-user Agent service. |
| \`bootstrap/ssh-agent.*\` | Install a matching Agent payload through canonical SSH setup. |
| \`PROJECT-SHA256SUMS\` | Integrity receipt for this generated repository tree. |
| \`.github/workflows/verify.yml\` | CI integrity and schema checks. |
| \`docs/DEPLOYMENT.md\` / \`docs/DEPLOYMENT.zh-CN.md\` | This guide, English and Simplified Chinese. |

## Attribution and licensing

This project intentionally identifies [upstream Happier](${UPSTREAM_HAPPIER_URL}) and does not relabel Happier as original Happier Anywhere code. The generated repository includes Happier's root MIT license unchanged as [\`LICENCE\`](../LICENCE), including the required copyright and permission notice for Happy Coder Contributors. Preserve that file and every other applicable upstream notice when redistributing source or binaries; document separate third-party licenses if you add new components.

Happier Anywhere is a deployment and operations companion to [Happier](${UPSTREAM_HAPPIER_URL}). For product behavior, App distribution, upstream source, issues, copyright, and license notices, consult the upstream repository; for this generated deployment repository, use [${catalog.repository.slug}](${projectUrl(catalog)}).`;
}

export function createProjectGuide(catalog) {
  return englishLanding(catalog);
}

export function createProjectDeploymentGuide(catalog) {
  return [
    englishGuideIntro(),
    englishGuideScope(),
    englishGuidePrerequisites(),
    englishGuideVerifyReleases(catalog),
    englishGuideDownload(),
    englishGuideExtract(),
    englishGuideController(),
    englishGuideTailscale(),
    englishGuideAgent(),
    englishGuideSshAgent(catalog),
    englishGuideFirstUse(),
    englishGuideDailyOperations(),
    englishGuideUpgradeRollback(),
    englishGuideTroubleshooting(catalog),
    englishGuideSecurityChecklist(),
    englishGuideRepositoryMap(catalog),
  ].join('\n\n') + '\n';
}

// ===== Chinese landing page (README.zh-CN.md) =====

function chineseAvailabilityWarning(catalog) {
  if (catalog.repository.availability === 'verified') {
    return '> **发布状态：** 本项目引用的版本化下载已经可用；下载脚本仍会在暂存前逐一验证文件。';
  }
  return '> **发布状态：** 这个项目仍在准备中。在 `catalog.json` 显示 `repository.availability: verified` 之前，不要把其中引用的版本化下载视为已经可用。';
}

function chineseLanding(catalog) {
  return `# Happier Anywhere

[English](README.md) | [简体中文](README.zh-CN.md)

**把运行在电脑和服务器上的 Codex、Claude Code 会话，带到手机、浏览器和 Happier App。**

一个私有 Relay 连接你选择的多台机器。编程工具仍在项目所在的电脑上运行，你可以换到另一台设备查看进度、发送指令、处理审批、中断任务或接管会话。

## Happier Anywhere 是什么？

[Happier](${UPSTREAM_HAPPIER_URL}) 是一个开源、端到端加密的 AI 编程助手客户端。Happier Anywhere 为它提供一套可直接部署的自托管方案，支持 Windows、Linux、macOS，也能通过 SSH 加入远端 Linux 或 macOS 主机。

这个仓库保存部署清单和安装辅助脚本，原生安装包放在带版本号的 Releases 中。因此，每台机器只需下载适合自身平台和用途的那一份。

## 快速开始

${chineseAvailabilityWarning(catalog)}

\`\`\`bash
git clone ${projectUrl(catalog)}.git
cd ${repositoryName(catalog)}
\`\`\`

从[支持的平台](#支持的平台)中选择主控机对应的目标 ID，替换占位符，然后先预览下载内容：

\`\`\`bash
TARGET_ID='<填写下方表格中的目标 ID>'
bash scripts/fetch.sh --plan --role controller --target "$TARGET_ID"
\`\`\`

\`\`\`powershell
$TargetId = '<填写下方表格中的目标 ID>'
.\\scripts\\fetch.ps1 -Plan -Role controller -TargetId $TargetId
\`\`\`

接下来：

1. 选一台可信、适合长期在线的电脑运行 Relay。
2. 检查预览结果。这个过程只显示将下载的内容，不会安装任何东西。
3. 按[部署指南](docs/DEPLOYMENT.zh-CN.md)下载并安装 Relay、配置私有 HTTPS，再加入实际运行 Codex 或 Claude Code 的电脑和 SSH 主机。
4. 在浏览器中打开私有地址，或把它添加到 Happier App。

指南分别提供 Windows PowerShell 和 Linux/macOS shell 的可复制命令，并在真正安装前解释每一步验证。

## 用手机或浏览器连接

项目和 AI 编程工具仍留在原来的电脑上，Happier 只是让你能从另一台设备看到并控制那里正在运行的会话。

- **Happier App：** 在 iOS 或 Android 安装原生 App，然后添加你的私有 Relay。
- **浏览器：** 从 tailnet 内的设备打开同一个私有 HTTPS 地址；无需安装浏览器扩展或 PWA。
- **桌面：** 可以直接使用浏览器，也可以在上游提供客户端时使用 Happier 桌面端。

移动 App 由上游 Happier 分发，不包含在这个仓库中：

| 平台 | 获取方式 |
| --- | --- |
| iPhone / iPad | [App Store](https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758554297) |
| Android（Play Store） | 私有测试版：先加入 [Happier Google 群组](https://groups.google.com/g/happier-dev)，再[从 Android](https://play.google.com/store/apps/details?id=dev.happier.app) 或[从网页](https://play.google.com/apps/testing/dev.happier.app)加入测试 |
| Android（直接安装） | [Happier 预览版 APK](https://github.com/happier-dev/happier/releases/download/ui-mobile-preview/happier-preview.apk) |

Relay 安装完成后，在 App 中添加它的私有 HTTPS 地址，并登录连接机器所使用的同一个 Happier 账户。

## 它能做什么

- 离开终端后继续查看 Codex 和 Claude Code 的实时进度。
- 发送指令、处理审批、中断任务，并在稍后继续。
- 接管已有的受支持会话，不必重新开始。
- 在一个界面中查看多台电脑和 SSH 主机上的会话。
- 同一套部署可供 Happier App、浏览器和桌面客户端使用。
- Relay 由你自己管理，只通过私有 HTTPS 提供访问。

## 整体结构

一台可信电脑运行 Relay；每台实际运行编程会话的电脑在后台连接到它；App 和浏览器再通过私有 HTTPS 访问 Relay。

\`\`\`text
浏览器 / Happier App
        |
        | 私有 HTTPS（推荐 Tailscale Serve；Funnel 保持关闭）
        v
Controller 上的 Relay（127.0.0.1:3005）
        |
        +-- Controller 本机的会话
        +-- 其他已接入电脑的会话
        +-- 经 SSH 安装的 Linux/macOS 主机会话
\`\`\`

| 角色 | 运行位置 | 作用 |
| --- | --- | --- |
| 主控机（Controller） | 一台可信、通常保持在线的电脑 | 运行私有 Relay。 |
| 节点（Agent） | 任何运行 AI 编程工具的电脑 | 让这台电脑上的会话可以通过 Relay 访问。 |
| SSH 节点 | Linux 或 macOS 远端主机 | 从主控机通过 SSH 安装的同一种 Agent。 |

整套部署只需要一台主控机。SSH 主机只运行 Agent，不再启动另一个 Relay。

## 支持的平台

${supportedPlatformTable(catalog, 'zh')}

只有上表列出的目标平台包含在当前生成项目中。Linux 和 macOS Agent 也可以通过 SSH 安装；远端主机仍只负责运行会话。

## 默认保持私有

- Happier 对会话内容进行端到端加密。
- Relay 只监听 \`127.0.0.1:3005\`，不直接监听局域网。
- 推荐使用 Tailscale Serve 提供私有 HTTPS；Funnel 保持关闭。
- 下载脚本只有在签名、SHA-256 和文件大小全部匹配时才会暂存安装包。
- 凭据、配对链接、私钥和 Relay 数据不应写入这个仓库或支持日志。

在开放 Relay 或给另一台机器安装前，请阅读完整的[安全检查表](docs/DEPLOYMENT.zh-CN.md#安全检查表)。

## 文档

- [安装和运维 Happier Anywhere](docs/DEPLOYMENT.zh-CN.md) · [English](docs/DEPLOYMENT.md)
- [上游 Happier 文档](https://docs.happier.dev/getting-started/onboarding)
- [上游 Happier 仓库](${UPSTREAM_HAPPIER_URL})
- [Happier Discord 社区](https://discord.gg/W6Pb8KuHfg)

## 基于 Happier 构建

Happier Anywhere 是 [Happier](${UPSTREAM_HAPPIER_URL}) 的部署配套项目，不会替代上游项目。生成仓库会在 [LICENCE](LICENCE) 中原样保留 Happier 的 MIT 许可证。`;
}

// ===== Chinese operator guide (docs/DEPLOYMENT.zh-CN.md) =====

function chineseGuideIntro() {
  return `# 部署指南 —— Happier Anywhere

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md) · 返回 [README](../README.md)

本指南是 Happier Anywhere 部署的运维手册，涵盖：核验并下载精确发布的工件、安装私有 Relay 与接入它的机器、日常运维、升级与故障排查。[README](../README.md) 用通俗语言介绍整体模型，本文档保留精确、关乎安全的关键细节。`;
}

function chineseGuideScope() {
  return `## 本仓库包含与不包含的内容

包含：资产目录（哈希与 Minisign 签名的组件校验清单交叉验证）、PowerShell/POSIX 下载验证器、按角色拆分的引导脚本、部署 Schema、完整性清单与 CI 验证。不包含：原生归档、移动 App、凭据、令牌、私钥、Relay 数据或公网网关。本仓库不会安装前置软件、自动提权、修改防火墙/路由器、配置 Tailscale、重启设备或静默接受主机信任提示。`;
}

function chineseGuidePrerequisites() {
  return `## 前置条件

- Git、\`tar\`、\`curl\`（Bash 下载器需要）以及 [Minisign](https://jedisct1.github.io/minisign/)。Windows 示例要求 PowerShell 5.1 或更高版本。
- 足够容纳所选原生归档和解压载荷的磁盘空间；下载目标目录不能已经存在。
- Codex、Claude Code 或其他受支持的 provider CLI，且必须由将来运行 Happier Agent 的同一操作系统用户完成安装和登录。
- SSH 安装还需要：可用的密钥或交互式 SSH、已经核对的主机身份，以及与远端系统和架构匹配的已解压 Agent 载荷。
- 通往 Relay 的私有 HTTPS 路径。推荐 Tailscale Serve；不要使用 Tailscale Funnel，也不要在局域网中明文暴露 Relay。
- 升级前准备经过测试、能够保留 ACL 的 Relay 数据与密钥备份流程。`;
}

function chineseGuideVerifyReleases(catalog) {
  const totalBytes = catalog.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  return `## 克隆仓库并核验 GitHub Releases 资产

\`\`\`bash
git clone ${projectUrl(catalog)}.git
cd ${repositoryName(catalog)}
\`\`\`

下载前先检查 \`catalog.json\`、\`assets.tsv\`、\`happier-release.pub\` 和 \`PROJECT-SHA256SUMS\`。组件 Release 标签分别为 \`cli-v${catalog.compatibility.cli}\` 与 \`server-v${catalog.compatibility.relay}\`。Git 标签和 Release URL 本身不足以作为完整性证据：辅助脚本会要求 HTTPS、Minisign 签名的组件校验清单、目录声明的 SHA-256 与字节大小全部一致。

${chineseRepositoryAvailability(catalog)}

下表直接由目录生成：共 ${catalog.artifacts.length} 个由校验值锁定的资产（总计 ${totalBytes} 字节），支持的目标 ID 为 ${targetList(catalog)}。请使用其中列出的精确归档名称与解压根目录内可执行文件，不要猜测平台路径。

${artifactInventory(catalog, 'zh')}`;
}

function chineseGuideDownload() {
  return `## 只选择并下载本机需要的内容

始终先执行 Plan，确认将要下载并暂存哪些内容。Controller 会选择同目标平台的 Agent CLI 与 Relay；Agent 和 SSH Agent 只选择 Agent CLI。

Windows Controller：

\`\`\`powershell
.\\scripts\\fetch.ps1 -Plan -Role controller -TargetId windows-x64
.\\scripts\\fetch.ps1 -Role controller -TargetId windows-x64 -OutDir .\\downloads\\controller
\`\`\`

Linux x64 本地 Agent：

\`\`\`bash
bash scripts/fetch.sh --plan --role agent --target linux-x64-glibc
bash scripts/fetch.sh --role agent --target linux-x64-glibc --out ./downloads/agent
\`\`\`

Linux x64 SSH Agent 载荷：

\`\`\`bash
bash scripts/fetch.sh --plan --role ssh-agent --target linux-x64-glibc
bash scripts/fetch.sh --role ssh-agent --target linux-x64-glibc --out ./downloads/ssh-agent
\`\`\`

签名、哈希、大小、HTTPS、路径或“输出目录已存在”检查只要有一项失败，都不要绕过。fetch 脚本只暂存通过全部验证的归档，既不安装也不运行。`;
}

function chineseGuideExtract() {
  return `## 解压到权限受限的暂存目录

命令中的大写名称是有意保留的占位符，请用上方生成表中的精确归档名称与解压根目录名称逐一替换。

Windows Controller（Agent CLI 与 Relay）：

\`\`\`powershell
New-Item -ItemType Directory -Path .\\runtime\\controller-cli,.\\runtime\\controller-relay
tar.exe -xzf .\\downloads\\controller\\EXACT_AGENT_ARCHIVE_FROM_TABLE -C .\\runtime\\controller-cli
tar.exe -xzf .\\downloads\\controller\\EXACT_RELAY_ARCHIVE_FROM_TABLE -C .\\runtime\\controller-relay
\`\`\`

仅安装 Windows 本地 Agent：

\`\`\`powershell
New-Item -ItemType Directory -Path .\\runtime\\agent
tar.exe -xzf .\\downloads\\agent\\EXACT_AGENT_ARCHIVE_FROM_TABLE -C .\\runtime\\agent
\`\`\`

Windows 上准备 SSH Agent 载荷：

\`\`\`powershell
New-Item -ItemType Directory -Path .\\runtime\\ssh-agent
tar.exe -xzf .\\downloads\\ssh-agent\\EXACT_REMOTE_AGENT_ARCHIVE_FROM_TABLE -C .\\runtime\\ssh-agent
\`\`\`

POSIX Controller 或 Agent：

\`\`\`bash
mkdir -p runtime/controller-cli runtime/controller-relay runtime/agent runtime/ssh-agent
tar -xzf downloads/controller/EXACT_AGENT_ARCHIVE_FROM_TABLE -C runtime/controller-cli
tar -xzf downloads/controller/EXACT_RELAY_ARCHIVE_FROM_TABLE -C runtime/controller-relay
tar -xzf downloads/agent/EXACT_AGENT_ARCHIVE_FROM_TABLE -C runtime/agent
tar -xzf downloads/ssh-agent/EXACT_REMOTE_AGENT_ARCHIVE_FROM_TABLE -C runtime/ssh-agent
\`\`\`

解压后，对照表格确认预期可执行文件是普通文件，并在 POSIX 系统上设置可执行位；可执行文件与载荷路径中不得出现符号链接或重解析点。传给引导脚本的应是解压后的二进制文件或载荷根目录，而不是归档文件。

从下一节开始，示例统一用 \`HAPPIER_BIN\`/\`$HappierBin\` 表示这条已验证的精确路径。这些脚本不会把 CLI 加入 \`PATH\`。`;
}

function chineseGuideController() {
  return `## 安装 Controller

选择一台电脑作为 Controller：引导脚本把服务所有权交给规范 Happier CLI，安装用户级 Relay host，并将监听地址固定为 \`127.0.0.1:3005\`。

Windows PowerShell：

\`\`\`powershell
$HappierBin = (Resolve-Path '.\\runtime\\controller-cli\\EXACT_AGENT_EXTRACTED_ROOT\\happier.exe').Path
$RelayBin = (Resolve-Path '.\\runtime\\controller-relay\\EXACT_RELAY_EXTRACTED_ROOT\\happier-server.exe').Path
.\\bootstrap\\controller.ps1 -HappierBinary $HappierBin -ServerBinary $RelayBin
\`\`\`

Linux/macOS：

\`\`\`bash
HAPPIER_BIN=/absolute/path/to/runtime/controller-cli/EXACT_AGENT_EXTRACTED_ROOT/happier
RELAY_BIN=/absolute/path/to/runtime/controller-relay/EXACT_RELAY_EXTRACTED_ROOT/happier-server
bash bootstrap/controller.sh "$HAPPIER_BIN" "$RELAY_BIN"
\`\`\`

脚本执行的受保护调用等价于 \`happier relay host install --server-binary ... --host 127.0.0.1 --mode user --yes --json --env PORT=3005\`。它会拒绝 \`HAPPIER_BOOTSTRAP_RELAY_PORT\`；如果 3005 端口已被占用，请先停止并确认占用者。不要改成通配监听，也不要为了继续执行而随意更换端口。

增加 HTTPS 入口前，先做本机验证：

\`\`\`powershell
& $HappierBin relay host status --mode user --json
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/ready
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/v1/features
$EngineIo = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3005/v1/updates/?EIO=4&transport=polling').Content
if (-not $EngineIo.StartsWith('0')) { throw 'Engine.IO handshake failed.' }
\`\`\`

\`\`\`bash
"$HAPPIER_BIN" relay host status --mode user --json
curl --fail http://127.0.0.1:3005/health
curl --fail http://127.0.0.1:3005/ready
curl --fail http://127.0.0.1:3005/v1/features
engine_io="$(curl --fail 'http://127.0.0.1:3005/v1/updates/?EIO=4&transport=polling')"
case "$engine_io" in 0*) ;; *) echo 'Engine.IO handshake failed.' >&2; exit 1 ;; esac
\`\`\`

不要直接启动 server 二进制文件：其通用 API 默认可能监听所有网卡。请走规范 \`happier relay host install\` 流程，让回环策略明确且可审计。`;
}

function chineseGuideTailscale() {
  return `## 使用 Tailscale Serve 增加私有 HTTPS

先检查既有状态，并保留无关配置：

\`\`\`bash
tailscale serve status --json
tailscale funnel status
\`\`\`

如果 \`tailscale serve status --json\` 返回的不是空 JSON 对象（\`{}\`）——尤其是 HTTPS \`:443\` 或根路径已被占用——请停止并人工审阅或合并配置。下面的命令只适用于无冲突的空基线，不能覆盖无关的 Serve 配置。

确认回环 HTTP 与实时 Engine.IO 健康检查都通过后，再配置私有 tailnet 入口：

\`\`\`bash
tailscale serve --bg --https=443 http://127.0.0.1:3005
tailscale serve status --json
tailscale funnel status
\`\`\`

将 Tailscale 返回的 HTTPS \`*.ts.net\` URL 同时用作 Relay 与 Web App 地址，并保持 Funnel 关闭。不要把 Docker/原生 Relay 发布到 \`0.0.0.0\`，不要向局域网直接暴露 3005 端口，不要创建明文网关，也不要按本指南的流程修改路由器或防火墙策略。`;
}

function chineseGuideAgent() {
  return `## 安装本地 Agent

如果 Controller 本身拥有本机 Codex/Claude 会话，也应在 Controller 上安装 Agent；凡是希望会话出现在 Happier 里的电脑，都要各自安装 Agent。

Windows：

\`\`\`powershell
$HappierBin = (Resolve-Path '.\\runtime\\agent\\EXACT_AGENT_EXTRACTED_ROOT\\happier.exe').Path
.\\bootstrap\\agent.ps1 -HappierBinary $HappierBin -ServerUrl https://your-private-name.ts.net
\`\`\`

Linux/macOS：

\`\`\`bash
HAPPIER_BIN=/absolute/path/to/runtime/agent/EXACT_AGENT_EXTRACTED_ROOT/happier
bash bootstrap/agent.sh "$HAPPIER_BIN" https://your-private-name.ts.net
\`\`\`

引导脚本按规范顺序调用 \`server set\`、\`auth login --no-open ... --persist\` 和 \`service install --mode user --yes --json\`。屏幕上显示的登录/配对流程需要由你本人完成——切勿把令牌粘贴进脚本、仓库、Shell 历史或支持日志。

验证用户级服务所有权：

\`\`\`powershell
& $HappierBin service status --mode user --json
& $HappierBin daemon status --json
\`\`\`

\`\`\`bash
"$HAPPIER_BIN" service status --mode user --json
"$HAPPIER_BIN" daemon status --json
\`\`\`

每个 Agent 身份只能有一个实际生效的 daemon/writer；一旦发现重复服务、所有权不明确、Relay URL 异常或身份不一致，请立即停止。`;
}

function chineseGuideSshAgent(catalog) {
  return `## 通过 SSH 安装 Agent

${chineseSshReleaseGate(catalog)}

下载并解压与**远端**平台匹配的 Agent 归档，然后从 Controller 运行 SSH 引导脚本。\`CliPayload\` 必须是解压后的载荷根目录——既不是归档，也不是 Controller 自己的载荷。

Windows Controller 到 Linux/macOS 目标机：

\`\`\`powershell
$HappierBin = (Resolve-Path '.\\runtime\\controller-cli\\EXACT_AGENT_EXTRACTED_ROOT\\happier.exe').Path
$RemotePayload = (Resolve-Path '.\\runtime\\ssh-agent\\EXACT_REMOTE_AGENT_EXTRACTED_ROOT').Path
.\\bootstrap\\ssh-agent.ps1 -HappierBinary $HappierBin -SshTarget user@remote-host -CliPayload $RemotePayload -ServerUrl https://your-private-name.ts.net
\`\`\`

Linux/macOS Controller：

\`\`\`bash
HAPPIER_BIN=/absolute/path/to/runtime/controller-cli/EXACT_AGENT_EXTRACTED_ROOT/happier
REMOTE_PAYLOAD=/absolute/path/to/runtime/ssh-agent/EXACT_REMOTE_AGENT_EXTRACTED_ROOT
bash bootstrap/ssh-agent.sh "$HAPPIER_BIN" user@remote-host "$REMOTE_PAYLOAD" https://your-private-name.ts.net
\`\`\`

脚本调用的是 \`happier machine setup --ssh ... --cli-payload ... --server-url ... --webapp-url ...\`。首次执行时省略 \`-Yes\` 或 \`--yes\`，以便人工核对主机信任与配对提示。规范的 machine owner 会验证平台兼容性、通过自己的 SSH/SCP 通道传输载荷、完成身份验证并负责远端 daemon 安装——不要另建第二套 systemd/launchd 服务。

桌面 Codex 客户端能控制某个 SSH 终端，并**不**代表 Happier 会自动看到该远端会话：SSH 主机需要运行自己的、已关联的 Happier Agent，而且只有 provider 集成能够安全识别/关联的会话才有资格显示。`;
}

function chineseGuideFirstUse() {
  return `## 从浏览器或 Happier App 开始使用

1. 让手机、平板或电脑加入同一个 tailnet，然后在浏览器中打开私有 HTTPS Relay URL。
2. 创建或登录预期的 Happier 账户，完成当前带身份验证的配对/claim 流程。
3. Android/iOS 设备应通过运营者信任的官方渠道，从 [上游 Happier](${UPSTREAM_HAPPIER_URL}) 获取原生 Happier App，再把它连接到同一个私有 HTTPS 地址和账户。本仓库不包含、不重新签名，也不独立认证移动端二进制文件。
4. 发送指令前确认预期的 Agent、操作系统用户、provider 身份与会话 owner。
5. 在 Agent 主机上以无子命令方式调用已验证的 \`HAPPIER_BIN\` 新建受管理会话；只有 Happier 明确显示“已安全关联”的现有会话才可直接使用。

Web UI 与原生 App 可以查看进度、发送指令、批准受支持的操作、中断/停止任务、恢复已停止的任务，并执行受支持的接管流程。具体可用能力取决于 provider 和会话类型——界面上出现按钮并不等于所有权已成功转移。

内嵌 Web UI 与 Relay 使用同一个私有 HTTPS 地址提供服务；本套件不声称支持浏览器安装或离线缓存。

另外，不要把目录中的 App 版本与运行时版本字段当作商店或 MDM 渠道已经发布该版本的证据：只有运营者信任的渠道真正提供所声明的版本、且真实设备完成配对之后，移动端验收才算通过。

### Direct、接管与接管并导入

下面的定义是操作层面的含义——**仅当已安装的上游 Happier App 与当前 provider/会话确实提供这些控件时才适用**。Happier Anywhere 本身不实现、也不启用这些能力，而且不同 Happier 版本之间的标签与能力可能不同。

- **Direct** 以会话所在机器上的 provider 记录为事实来源；Happier 接管之前可能只能查看，机器离线时不可用。界面一直显示“Direct”并不能证明已经接管。
- **接管（Take over）** 让 Happier 获得会话控制权，但不导入会话记录；会话仍保持 Direct，并由 provider 持有记录。只能在真正空闲、安全的回合边界执行，且必须先核对精确的 session ID、owner 与 cursor，确认没有工具调用或待写入者。
- **接管并导入（Take over + import）** 将会话记录导入 Happier，把会话切换为 Happier 持久化存储，并继续使用完整的受支持 Happier 会话功能。选择前先记下当前可见的历史边界；完成后检查是否有缺口或重复消息，一旦出现冲突/覆盖警告立即停止。
- 不允许两个 daemon、终端或设备同时写同一会话。接管后的第一条消息应使用无害、只读的确认指令。

### CLI 使用示例

下面使用 POSIX 写法；PowerShell 请用 \`& $HappierBin\` 加相同参数。

\`\`\`bash
# 交互式启动新的 provider 会话
"$HAPPIER_BIN"

# 查找并检查会话
"$HAPPIER_BIN" session list --active
"$HAPPIER_BIN" session status <session-id> --live

# 发送一条指令并等待结果
"$HAPPIER_BIN" session send <session-id> "只总结当前状态" --wait

# 停止、恢复或附加终端
"$HAPPIER_BIN" session stop <session-id>
"$HAPPIER_BIN" resume <session-id>
"$HAPPIER_BIN" attach <session-id>
\`\`\`

如果多个会话的 ID 前缀相似，请使用完整 ID。审批、中断、恢复或接管前再次核对身份与 owner。`;
}

function chineseGuideDailyOperations() {
  return `## 日常运维

| 目的 | 命令 |
| --- | --- |
| Relay 状态 | \`"$HAPPIER_BIN" relay host status --mode user --json\` |
| Relay 启动/停止/重启 | \`"$HAPPIER_BIN" relay host start\\|stop\\|restart --mode user --json\` |
| Agent 服务状态 | \`"$HAPPIER_BIN" service status --mode user --json\` |
| Agent 服务启动/停止/重启 | \`"$HAPPIER_BIN" service start\\|stop\\|restart --mode user --json\` |
| Daemon 状态 | \`"$HAPPIER_BIN" daemon status --json\` |
| 活动会话 | \`"$HAPPIER_BIN" session list --active\` |
| 实时会话 | \`"$HAPPIER_BIN" session status <id> --live\` |
| 私有网关 | \`tailscale serve status --json\` |
| 公网暴露反向检查 | \`tailscale funnel status\` |

除非有意迁移所有权和凭据，否则不要用另一个操作系统账户执行 provider 或 Happier 服务操作。`;
}

function chineseGuideUpgradeRollback() {
  return `## 升级与回滚

请在维护窗口内执行升级，并确保没有活跃的 Relay writer。先停止规范 Relay，对其数据库（适用时包括 SQLite WAL/SHM）、文件、配置、master secret 与 ACL 做完整备份并验证。仍通过相同的签名/哈希/大小门禁下载新版本资产，然后由规范服务 owner 完成更新——绝不要原地替换正在运行的可执行文件。

二进制回滚与数据回滚是两件不同的事：重新安装旧版可执行文件并不会回滚已迁移的数据库，数据恢复必须采用另行批准且经过测试的流程。任何变更之后，都要重新核验回环健康、HTTPS、Engine.IO/Socket.IO、每个 Agent 只有一个 daemon/writer、Funnel 关闭，以及不存在通配或公网监听。`;
}

function chineseGuideTroubleshooting(catalog) {
  return `## 故障排查

| 现象 | 安全的下一步 |
| --- | --- |
| Release URL 返回 404 / 可用性为 \`not-verified\` | 在[本项目仓库](${projectUrl(catalog)})确认精确版本的 Release/标签确实存在；不要改用 \`latest\` 或未签名镜像。 |
| 缺少 \`minisign\` | 从可信软件源安装 Minisign，再重新执行 Plan/下载；不要关闭签名验证。 |
| 签名/哈希/大小不匹配 | 只删除本次新建且验证失败的暂存下载，核对可信公钥/目录并调查来源。 |
| 3005 端口被占用 | 确认已有监听进程后停止；不要改用通配地址或未记录的端口覆盖。 |
| 私有 HTTPS 不可用 | 先检查本机 \`/health\` 与 \`/ready\`，再查 \`tailscale serve status --json\`；Funnel 保持关闭。 |
| Agent 离线 | 用已验证 CLI 路径检查 \`service status --json\` 与 \`daemon status --json\`，再检查 Relay URL、账户和 tailnet 连通性。 |
| SSH 安装失败 | 重新核对主机身份、SSH、远端 OS/架构、已解压载荷根目录和 HTTPS URL；不要手写第二个 daemon 服务。 |
| 找不到现有 Codex 会话 | 确认 Agent 运行在会话实际所在的主机和用户下，再检查 provider 的会话关联能力；另一处能控制 SSH 终端并不充分。 |
| App 看起来连续发送两条相同消息 | 停止继续发送；核对只有一个 Agent/daemon/writer、准确 owner、pending-message 对账，以及重复项是否只是 UI echo。 |`;
}

function chineseGuideSecurityChecklist() {
  return `## 安全检查表

- Relay 仅监听 \`127.0.0.1:3005\`；私有 HTTPS 由 Tailscale Serve 或同等的带身份验证网关终止。
- Tailscale Funnel、公网 DNS 暴露、局域网明文访问、通配监听和 Docker 直接发布端口都保持关闭。
- Release 资产 URL、Minisign 签名、SHA-256、字节大小、目标平台与解压路径全部和目录一致。
- 凭据、令牌、配对链接、二维码载荷、密钥、环境变量转储、私钥和 Relay 数据不会进入 Git 或支持输出。
- 服务文件和密钥由规范用户级安装器持有，并使用严格 ACL。
- 只有一个 Relay writer；每个 Agent 身份也只有一个 daemon/writer。
- 只有在已验证的空闲边界、精确身份与 owner 核对通过后才接管。
- 升级前已经验证备份与回滚流程。`;
}

function chineseGuideRepositoryMap(catalog) {
  return `## 仓库内容

| 路径 | 用途 |
| --- | --- |
| \`catalog.json\` / \`deployment-catalog.schema.json\` | 机器可读的角色、目标、版本、URL、哈希、大小和 Schema。 |
| \`assets.tsv\` | 便于人工审阅的资产索引。 |
| \`happier-release.pub\` | 验证组件校验清单所使用的 Minisign 公钥。 |
| \`LICENCE\` | 原样保留的上游 Happier 根目录 MIT 许可证与版权声明。 |
| \`scripts/fetch.ps1\`、\`scripts/fetch.sh\` | 规划并只暂存所选、验证通过的原生归档。 |
| \`bootstrap/controller.*\` | 通过规范 Happier owner 安装仅回环监听的 Relay。 |
| \`bootstrap/agent.*\` | 配置、登录并安装本地用户级 Agent 服务。 |
| \`bootstrap/ssh-agent.*\` | 通过规范 SSH setup 安装匹配的 Agent 载荷。 |
| \`PROJECT-SHA256SUMS\` | 生成仓库树的完整性清单。 |
| \`.github/workflows/verify.yml\` | CI 完整性与 Schema 检查。 |
| \`docs/DEPLOYMENT.md\` / \`docs/DEPLOYMENT.zh-CN.md\` | 本指南，英文与简体中文。 |

## 上游归属与许可证

本项目明确标注[上游 Happier](${UPSTREAM_HAPPIER_URL})，不会把 Happier 重新标记为 Happier Anywhere 的原创代码。生成仓库会将 Happier 根目录的 MIT 许可证原样收录为 [\`LICENCE\`](../LICENCE)，其中包含 Happy Coder Contributors 的必要版权与许可声明。再分发源码或二进制文件时必须保留该文件及其他所有适用的上游声明；如果新增第三方组件，还要单独记录其许可证。

Happier Anywhere 是 [Happier](${UPSTREAM_HAPPIER_URL}) 的部署与运维配套项目。产品行为、App 分发、上游源码、问题、版权与许可证声明以 Happier 上游仓库为准；本部署项目位于 [${catalog.repository.slug}](${projectUrl(catalog)})。`;
}

export function createProjectGuideChinese(catalog) {
  return chineseLanding(catalog);
}

export function createProjectDeploymentGuideChinese(catalog) {
  return [
    chineseGuideIntro(),
    chineseGuideScope(),
    chineseGuidePrerequisites(),
    chineseGuideVerifyReleases(catalog),
    chineseGuideDownload(),
    chineseGuideExtract(),
    chineseGuideController(),
    chineseGuideTailscale(),
    chineseGuideAgent(),
    chineseGuideSshAgent(catalog),
    chineseGuideFirstUse(),
    chineseGuideDailyOperations(),
    chineseGuideUpgradeRollback(),
    chineseGuideTroubleshooting(catalog),
    chineseGuideSecurityChecklist(),
    chineseGuideRepositoryMap(catalog),
  ].join('\n\n') + '\n';
}
