// @ts-check

function requireManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 'happier-deployment-kit/v1') {
    throw new Error('[deployment-kit] guide requires a v1 deployment manifest');
  }
  return manifest;
}

function targetLabel(target) {
  return [target?.os, target?.arch, target?.libc].filter(Boolean).join('-');
}

function channelList(platform) {
  if (!Array.isArray(platform?.channels)) return 'none declared';
  const displayNames = {
    'google-play': 'Google Play',
    'signed-apk': 'signed APK',
    'app-store': 'App Store',
    testflight: 'TestFlight',
    mdm: 'MDM',
  };
  return platform.channels
    .map((channel) => displayNames[channel?.id] ?? channel?.id)
    .filter(Boolean)
    .join(', ');
}

function mobileDistributionInstructions(mobile) {
  const distribution = mobile?.distribution;
  if (distribution?.mode !== 'external-app') {
    return `- Android channels: ${channelList(mobile?.android)}.
- iOS channels: ${channelList(mobile?.ios)}. iOS artifacts require Apple signing/provisioning; no generic sideloadable IPA is claimed.`;
  }

  return `- Mobile distribution mode: \`external-app\`. Mobile artifacts are not included in this kit; APK, AAB, and IPA artifact verification was not performed.
- Signing verification: \`${distribution.signingVerificationStatus ?? 'unknown'}\`; publication verification: \`${distribution.publicationVerificationStatus ?? 'unknown'}\`; channel availability: \`${distribution.channelAvailabilityStatus ?? 'unknown'}\`; device validation: \`${distribution.deviceValidationStatus ?? 'unknown'}\`.
- Android external acquisition channels: ${channelList(mobile?.android)}. Android required App version \`${mobile?.android?.requiredClaimV1AppVersion ?? 'unknown'}\` and runtime \`${mobile?.android?.requiredRuntimeVersion ?? 'unknown'}\` for \`claim-v1\` are compatibility requirements, not observations of an installed App.
- iOS external acquisition channels: ${channelList(mobile?.ios)}. iOS required App version \`${mobile?.ios?.requiredClaimV1AppVersion ?? 'unknown'}\` and runtime \`${mobile?.ios?.requiredRuntimeVersion ?? 'unknown'}\` for \`claim-v1\` are compatibility requirements, not observations of an installed App. Generic iOS sideload remains forbidden.
- Obtain the native App independently through an authenticated, operator-trusted channel. Mobile acceptance remains BLOCKED until that channel actually provides the declared claim-v1 version and a real device completes pairing.
- A new Relay emits \`claim-v1\`; there is currently no force-legacy QR action. An older App that cannot parse \`claim-v1\` must be upgraded and must not be counted as compatible.`;
}

export function createDeploymentKitGuide(manifestInput) {
  const manifest = requireManifest(manifestInput);
  const targets = [...new Set(manifest.artifacts.map((artifact) => targetLabel(artifact.target)))].sort();
  const agentOffline = manifest.installation?.agent?.offline === true;
  const pairingStatus = String(manifest.mobile?.pairing?.runtimeIntegrationStatus ?? 'unknown');
  const pairingLiveStatus = String(manifest.mobile?.pairing?.liveDeviceValidationStatus ?? 'unknown');
  const pushMode = String(manifest.mobile?.push?.mode ?? 'unknown');
  const mobileInstructions = mobileDistributionInstructions(manifest.mobile);
  const credentialContentStatus = String(manifest.securityPolicy?.credentialContentStatus ?? 'unknown');
  const offlineAgentInstructions = agentOffline
    ? `### Offline SSH Agent

Run the SSH bootstrap on the Controller. The payload path is a verified, extracted Agent payload for the remote operating system and architecture, not an archive and not the Controller payload.

Windows Controller (PowerShell 5.1+):

\`bootstrap/ssh-agent.ps1 -HappierBinary <controller-happier.exe> -SshTarget <user@linux-or-macos-host> -CliPayload <verified-extracted-agent-payload-root> -ServerUrl <https-relay-origin> [-WebappUrl <https-webapp-origin>] [-Yes]\`

Linux/macOS Controller (POSIX shell):

\`bootstrap/ssh-agent.sh <controller-happier> <user@linux-or-macos-host> <verified-extracted-agent-payload-root> <https-relay-origin> [https-webapp-origin] [--yes]\`

These scripts pass \`--cli-payload\` to the canonical \`happier machine setup\` SSH owner. That owner validates the payload against the observed remote OS/architecture, copies it through the existing SCP corridor, performs authentication, and owns daemon-service installation. The bootstrap does not extract on the remote host or write a service definition. Omit \`-Yes\`/\`--yes\` to review host-trust and pairing prompts interactively; using it explicitly accepts those canonical prompts.

Agent offline bootstrap is available through the manifest-declared canonical payload seam.`
    : `Agent offline bootstrap is not yet available (${manifest.installation?.agent?.offlineBlocker ?? 'no offline payload seam'}). Use the online canonical machine setup path until that seam is present.`;

  return `# Happier Deployment Kit ${manifest.kitVersion}

This directory is a role-first deployment kit. Run exactly one Controller Relay and one or more Agent daemons. Web, Android, and iOS are clients; they are not additional Relays.

Channel: \`${manifest.channel}\`
Source reproducibility: \`${manifest.source?.reproducibility ?? 'unknown'}\`
Credential content audit: \`${credentialContentStatus}\`
Targets: ${targets.map((target) => `\`${target}\``).join(', ')}

## 1. Verify before extraction

Obtain the trusted kit tree SHA256 or release signature through a separate authenticated channel. Verify every entry in \`SHA256SUMS\` before extracting an archive. A local-channel kit is integrity-closed but unsigned; do not treat it as a public stable release.

The manifest rejects credential-like artifact paths, but the assembler does not inspect arbitrary archive contents. Credential content remains \`${credentialContentStatus}\`; audit every supplied artifact before sharing the kit.

## 2. Choose roles

- Controller: choose one \`packs/controller\` archive for the Controller operating system and architecture.
- Agent: choose the matching \`packs/agent\` archive for each computer that will run Codex/Claude/SSH tasks.
- Do not run a Relay on every Agent. The default Agent role is daemon-only.
- Native Relay and Docker Relay are mutually exclusive deployment backends. Do not point both at the same data.

## 3. Install the Controller

Extract the selected Agent CLI archive and Controller Relay archive into a restricted staging directory. Reject symbolic links and pass the extracted executable paths, not the archive paths, to the bootstrap.

Windows PowerShell 5.1+:

\`bootstrap/controller.ps1 -HappierBinary <extracted-happier.exe> -ServerBinary <extracted-happier-server.exe>\`

Linux/macOS POSIX shell:

\`bootstrap/controller.sh <extracted-happier> <extracted-happier-server>\`

The bootstrap delegates installation to \`happier relay host install\`. It binds only \`127.0.0.1:${manifest.securityPolicy?.relayPort ?? 3005}\`; it does not change Tailscale, a firewall, a router, or DNS. Because this v1 bootstrap has no manifest input, its protected port is fixed to 3005 and it stops if \`HAPPIER_BOOTSTRAP_RELAY_PORT\` is present.

## 4. Add HTTPS access

Put an authenticated HTTPS gateway in front of the loopback Relay. Tailscale Serve over HTTPS is supported; Tailscale Funnel is forbidden. Plaintext LAN exposure and wildcard \`0.0.0.0\` listeners are forbidden.

Configure exposure only after \`/v1/features\`, Socket.IO/Engine.IO, and the loopback listener pass health checks. Exposure is a separate operator action and is never performed by the install bootstrap.

## 5. Install Agents

### Local Agent

Windows:

\`bootstrap/agent.ps1 -HappierBinary <extracted-happier.exe> -ServerUrl <https-relay-origin>\`

Linux/macOS:

\`bootstrap/agent.sh <extracted-happier> <https-relay-origin>\`

The Agent bootstrap delegates profile, interactive authentication, and automatic startup to the existing Happier CLI/service owner. It never writes systemd, launchd, or Windows service definitions itself.

${offlineAgentInstructions}

## 6. Use Web and native Happier Apps

- Web UI: open the same HTTPS Relay origin in a browser. It is browser-capable; it is not an installable PWA or offline app.
${mobileInstructions}
- Pairing contract: \`claim-v1\`, runtime state \`${pairingStatus}\`, live-device validation \`${pairingLiveStatus}\`. Do not claim phone pairing is field-verified until Relay/App report \`implemented\` and live-device validation reports \`verified\`.
- Push mode: \`${pushMode}\`. Private mode has foreground realtime but no background APNs/FCM wakeup.

## 7. Upgrade and rollback

Use a maintenance window and prove there is no active Relay writer. Stop the Relay, then take a full data snapshot containing SQLite DB/WAL/SHM, files, master secret, and configuration while preserving ACLs. Verify the snapshot digest before installing a new binary.

The current CLI provides only \`happier relay host snapshot --preflight\`. It inventories the stopped-writer/source boundary but deliberately returns BLOCKED: an ACL-preserving, digest-producing snapshot backend and restore rehearsal are not yet verified across Windows, Linux, and macOS. Use an independently validated operator backup procedure; do not treat preflight as a backup.

The canonical Relay owner can roll back binaries and service definitions. Data rollback is a separate, explicitly approved operator action; reinstalling an old binary is not a full database rollback.

After any change, verify loopback health, HTTPS reachability, Socket.IO, exactly one daemon/writer per Agent, Funnel disabled, and no wildcard/public listeners.
`;
}
