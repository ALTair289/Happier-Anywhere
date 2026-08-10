// @ts-check

import { posix } from 'node:path';

import { createMobileDeploymentFragment } from './deployment-kit-mobile.mjs';
import {
  assertDeploymentKitManifestSchema,
  HAPPIER_DEPLOYMENT_KIT_ARTIFACT_VARIANTS,
  HAPPIER_DEPLOYMENT_KIT_TARGETS,
} from './deployment-kit-schema.mjs';

export const HAPPIER_DEPLOYMENT_KIT_SCHEMA_VERSION = 'happier-deployment-kit/v1';

const CHANNELS = new Set(['local', 'dev', 'preview', 'stable']);
const ROLES = new Set(['agent', 'controller']);
const CANONICAL_ARTIFACT_TARGET_KEYS = new Set(HAPPIER_DEPLOYMENT_KIT_TARGETS.map((target) => targetKey(target)));
const CANONICAL_ARTIFACT_VARIANTS = new Set(HAPPIER_DEPLOYMENT_KIT_ARTIFACT_VARIANTS);

function requireNonBlank(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`[deployment-kit] ${label} is required`);
  return normalized;
}

function requireSafeSegment(value, label) {
  const normalized = requireNonBlank(value, label);
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(normalized)) {
    throw new Error(`[deployment-kit] invalid ${label}: ${normalized}`);
  }
  return normalized;
}

function requireSha256(value, label) {
  const normalized = requireNonBlank(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`[deployment-kit] ${label} must be a 64 character hexadecimal SHA256`);
  }
  return normalized;
}

function normalizeSource(source, channel) {
  const commitSha = requireNonBlank(source?.commitSha, 'source commit SHA').toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(commitSha)) {
    throw new Error('[deployment-kit] source commit SHA must be 40-64 hexadecimal characters');
  }
  const workspaceDirty = source?.workspaceDirty === true;
  if (channel !== 'local' && workspaceDirty) {
    throw new Error('[deployment-kit] non-local deployment kit requires a clean workspace');
  }
  const workspaceSnapshotSha256 = workspaceDirty
    ? requireSha256(source?.workspaceSnapshotSha256, 'dirty workspace snapshot')
    : null;
  return {
    commitSha,
    workspaceState: workspaceDirty ? 'dirty' : 'clean',
    workspaceSnapshotSha256,
    reproducibility: 'not-verified',
  };
}

function normalizeTarget(target) {
  const os = requireSafeSegment(target?.os, 'target OS').toLowerCase();
  const arch = requireSafeSegment(target?.arch, 'target architecture').toLowerCase();
  const libcRaw = String(target?.libc ?? '').trim();
  return {
    os,
    arch,
    ...(libcRaw ? { libc: requireSafeSegment(libcRaw, 'target libc').toLowerCase() } : {}),
  };
}

function targetKey(target) {
  return [target.os, target.arch, target.libc].filter(Boolean).join('-');
}

function normalizeArtifactPath(value) {
  const raw = requireNonBlank(value, 'artifact path');
  if (raw.includes('\\') || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`[deployment-kit] unsafe artifact path: ${raw}`);
  }
  const normalized = posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== raw) {
    throw new Error(`[deployment-kit] unsafe artifact path: ${raw}`);
  }
  const segments = normalized.toLowerCase().split('/');
  const credentialLike = segments.some((segment) => (
    /^\.env(?:\..*)?$/.test(segment)
    || /^id_(?:rsa|ed25519|ecdsa)(?:\..*)?$/.test(segment)
    || /^(?:credentials?|secrets?|tokens?)(?:\..*)?$/.test(segment)
  ));
  if (credentialLike) {
    throw new Error(`[deployment-kit] credential-like artifact path is forbidden: ${raw}`);
  }
  return normalized;
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('[deployment-kit] at least one artifact is required');
  }
  const identities = new Set();
  const ids = new Set();
  return artifacts.map((artifact) => {
    const id = requireSafeSegment(artifact?.id, 'artifact id');
    if (ids.has(id)) throw new Error(`[deployment-kit] duplicate artifact id: ${id}`);
    ids.add(id);
    const role = requireSafeSegment(artifact?.role, 'artifact role').toLowerCase();
    if (!ROLES.has(role)) throw new Error(`[deployment-kit] unsupported artifact role: ${role}`);
    const variant = String(artifact?.variant ?? 'native').trim().toLowerCase() || 'native';
    requireSafeSegment(variant, 'artifact variant');
    if (!CANONICAL_ARTIFACT_VARIANTS.has(variant)) {
      throw new Error(`[deployment-kit] unsupported artifact variant: ${variant}`);
    }
    const target = normalizeTarget(artifact?.target);
    const normalizedTargetKey = targetKey(target);
    if (!CANONICAL_ARTIFACT_TARGET_KEYS.has(normalizedTargetKey)) {
      throw new Error(`[deployment-kit] unsupported native target: ${normalizedTargetKey}`);
    }
    const identity = `${role}/${targetKey(target)}/${variant}`;
    if (identities.has(identity)) {
      throw new Error(`[deployment-kit] duplicate artifact role/target/variant: ${identity}`);
    }
    identities.add(identity);
    const size = Number(artifact?.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`[deployment-kit] artifact size must be a positive safe integer: ${id}`);
    }
    return {
      id,
      role,
      target,
      variant,
      format: requireSafeSegment(artifact?.format, 'artifact format'),
      path: normalizeArtifactPath(artifact?.path),
      sha256: requireSha256(artifact?.sha256, `artifact ${id} SHA256`),
      size,
    };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function assertCompleteRoleCoverage(artifacts) {
  const targets = new Map();
  for (const artifact of artifacts) {
    const key = targetKey(artifact.target);
    const record = targets.get(key) ?? new Set();
    record.add(artifact.role);
    targets.set(key, record);
  }
  for (const [key, roles] of targets) {
    for (const role of ['agent', 'controller']) {
      if (!roles.has(role)) throw new Error(`[deployment-kit] missing ${role} artifact for ${key}`);
    }
  }
}

export function createDeploymentKitManifest(input) {
  const kitVersion = requireSafeSegment(input?.kitVersion, 'kit version');
  const channel = requireSafeSegment(input?.channel, 'channel').toLowerCase();
  if (!CHANNELS.has(channel)) throw new Error(`[deployment-kit] unsupported channel: ${channel}`);
  const source = normalizeSource(input?.source, channel);
  const artifacts = normalizeArtifacts(input?.artifacts);
  assertCompleteRoleCoverage(artifacts);
  const versions = {
    cli: requireSafeSegment(input?.versions?.cli, 'CLI version'),
    relay: requireSafeSegment(input?.versions?.relay, 'Relay version'),
    webUi: requireSafeSegment(input?.versions?.webUi, 'Web UI version'),
    protocol: requireSafeSegment(input?.versions?.protocol, 'protocol version'),
    androidApp: requireSafeSegment(input?.versions?.androidApp, 'Android App version'),
    iosApp: requireSafeSegment(input?.versions?.iosApp, 'iOS App version'),
  };
  const mobile = createMobileDeploymentFragment(input?.mobile);
  if (!mobile.protocol.supportedVersions.includes(versions.protocol)) {
    throw new Error('[deployment-kit] mobile App does not support the deployment protocol version');
  }
  const declaredAndroidAppVersion = mobile.distribution?.mode === 'external-app'
    ? mobile.android.requiredClaimV1AppVersion
    : mobile.android.appVersion;
  const declaredIosAppVersion = mobile.distribution?.mode === 'external-app'
    ? mobile.ios.requiredClaimV1AppVersion
    : mobile.ios.appVersion;
  if (declaredAndroidAppVersion !== versions.androidApp) {
    throw new Error('[deployment-kit] Android App version does not match compatibility metadata');
  }
  if (declaredIosAppVersion !== versions.iosApp) {
    throw new Error('[deployment-kit] iOS App version does not match compatibility metadata');
  }

  const manifest = {
    schemaVersion: HAPPIER_DEPLOYMENT_KIT_SCHEMA_VERSION,
    product: 'happier-deployment-kit',
    kitVersion,
    channel,
    source,
    compatibility: {
      protocol: versions.protocol,
      cli: versions.cli,
      relay: versions.relay,
      webUi: versions.webUi,
      androidApp: versions.androidApp,
      iosApp: versions.iosApp,
    },
    topology: {
      controller: { recommendedCount: 1, componentRole: 'controller' },
      agents: { minimumCount: 1, componentRole: 'agent', defaultServiceRole: 'daemon-only' },
      clients: ['web', 'android', 'ios'],
    },
    securityPolicy: {
      relayBindHost: '127.0.0.1',
      relayPort: 3005,
      requireHttpsGateway: true,
      allowTailscaleServe: true,
      allowTailscaleFunnel: false,
      allowPlaintextLan: false,
      credentialContentStatus: 'not-verified',
    },
    installation: {
      controller: {
        online: true,
        offline: true,
        owner: 'happier-relay-host',
      },
      agent: {
        online: true,
        offline: true,
        owner: 'happier-machine-setup',
        offlineBlocker: null,
      },
    },
    rollback: {
      binaryAndService: 'canonical-owner',
      data: 'operator-backup-required',
      maintenanceWindowRequired: true,
    },
    mobile,
    artifacts,
  };
  return assertDeploymentKitManifestSchema(manifest);
}
