import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialFingerprint,
} from './nativeAuth/claudeCodeCredentialFile';

export const CLAUDE_CONNECTED_SERVICE_HOME_PROVENANCE_FILE_NAME =
  '.happier-claude-connected-service-home.json';

type ClaudeConnectedServiceHomeSelectionProvenance =
  | Readonly<{
      kind: 'profile';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
    }>;

export type ClaudeConnectedServiceHomeSelectionDescriptor =
  ClaudeConnectedServiceHomeSelectionProvenance & Readonly<{
    serviceId: 'claude-subscription';
  }>;

/**
 * Last credential we successfully wrote into the derived macOS keychain item for this home.
 *
 * P0 keychain-clobber fix (2026-07-08): the shared `__groups/claude` keychain item is often
 * ACL-unreadable by the daemon (`security` non-zero exit is indistinguishable from "absent"), so the
 * keychain read can never be the comparator basis. The daemon owns materialization, so it records the
 * fingerprint of the last-written payload here (next to the home) and compares INCOMING vs
 * LAST-WRITTEN. Identical → skip the write entirely (no `add-generic-password -U`, no ACL re-write,
 * no clobber of running sibling claude processes). Fingerprint only — never a secret value.
 */
export type ClaudeConnectedServiceHomeMacOsKeychainCredentialProvenance = Readonly<{
  credentialFingerprint: string;
  writtenAtMs: number;
}>;

export type ClaudeConnectedServiceHomeProvenanceV1 = Readonly<{
  v: 1;
  serviceId: 'claude-subscription';
  credentialProfileId: string;
  credentialCreatedAt: number;
  credentialFingerprint?: string | undefined;
  macOsKeychainCredential?: ClaudeConnectedServiceHomeMacOsKeychainCredentialProvenance | undefined;
  selection: ClaudeConnectedServiceHomeSelectionProvenance;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCredentialFingerprint(value: unknown): string | undefined {
  const text = readNonBlankString(value);
  return text?.match(/^sha256:[a-f0-9]{64}$/) ? text : undefined;
}

function readMacOsKeychainCredentialProvenance(
  value: unknown,
): ClaudeConnectedServiceHomeMacOsKeychainCredentialProvenance | undefined {
  const root = readObject(value);
  const credentialFingerprint = readCredentialFingerprint(root?.credentialFingerprint);
  const writtenAtMs = readFiniteNumber(root?.writtenAtMs);
  return credentialFingerprint && writtenAtMs !== null
    ? { credentialFingerprint, writtenAtMs }
    : undefined;
}

function buildCredentialFingerprint(record: ConnectedServiceCredentialRecordV1): string | undefined {
  const built = buildClaudeCodeCredentialPayload(record);
  return built.status === 'ok'
    ? computeClaudeCodeCredentialFingerprint(built.payload)
    : undefined;
}

export function resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir: string): string {
  return join(claudeConfigDir, CLAUDE_CONNECTED_SERVICE_HOME_PROVENANCE_FILE_NAME);
}

export function buildClaudeConnectedServiceHomeProvenance(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeConnectedServiceHomeSelectionDescriptor;
}>): ClaudeConnectedServiceHomeProvenanceV1 {
  const credentialFingerprint = buildCredentialFingerprint(params.record);
  if (params.selectionDescriptor.kind === 'group') {
    return {
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId: params.record.profileId,
      credentialCreatedAt: params.record.createdAt,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      selection: {
        kind: 'group',
        groupId: params.selectionDescriptor.groupId,
        activeProfileId: params.selectionDescriptor.activeProfileId,
        fallbackProfileId: params.selectionDescriptor.fallbackProfileId,
      },
    };
  }
  return {
    v: 1,
    serviceId: 'claude-subscription',
    credentialProfileId: params.record.profileId,
    credentialCreatedAt: params.record.createdAt,
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
    selection: {
      kind: 'profile',
      profileId: params.selectionDescriptor.profileId,
    },
  };
}

export function parseClaudeConnectedServiceHomeProvenance(
  value: unknown,
): ClaudeConnectedServiceHomeProvenanceV1 | null {
  const root = readObject(value);
  if (!root || root.v !== 1 || root.serviceId !== 'claude-subscription') return null;
  const credentialProfileId = readNonBlankString(root.credentialProfileId);
  const credentialCreatedAt = readFiniteNumber(root.credentialCreatedAt);
  const credentialFingerprint = readCredentialFingerprint(root.credentialFingerprint);
  const macOsKeychainCredential = readMacOsKeychainCredentialProvenance(root.macOsKeychainCredential);
  const selection = readObject(root.selection);
  if (!credentialProfileId || credentialCreatedAt === null || !selection) return null;
  if (selection.kind === 'profile') {
    const profileId = readNonBlankString(selection.profileId);
    if (!profileId) return null;
    return {
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId,
      credentialCreatedAt,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      ...(macOsKeychainCredential ? { macOsKeychainCredential } : {}),
      selection: {
        kind: 'profile',
        profileId,
      },
    };
  }
  if (selection.kind === 'group') {
    const groupId = readNonBlankString(selection.groupId);
    const activeProfileId = readNonBlankString(selection.activeProfileId);
    const fallbackProfileId = readNonBlankString(selection.fallbackProfileId);
    if (!groupId || !activeProfileId || !fallbackProfileId) return null;
    return {
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId,
      credentialCreatedAt,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      ...(macOsKeychainCredential ? { macOsKeychainCredential } : {}),
      selection: {
        kind: 'group',
        groupId,
        activeProfileId,
        fallbackProfileId,
      },
    };
  }
  return null;
}

export async function readClaudeConnectedServiceHomeProvenance(
  claudeConfigDir: string,
): Promise<ClaudeConnectedServiceHomeProvenanceV1 | null> {
  try {
    return parseClaudeConnectedServiceHomeProvenance(
      JSON.parse(await readFile(resolveClaudeConnectedServiceHomeProvenancePath(claudeConfigDir), 'utf8')),
    );
  } catch {
    return null;
  }
}

export function matchesClaudeConnectedServiceHomeProvenance(
  expected: ClaudeConnectedServiceHomeProvenanceV1,
  actual: ClaudeConnectedServiceHomeProvenanceV1 | null | undefined,
): boolean {
  if (!actual) return false;
  if (
    actual.v !== expected.v
    || actual.serviceId !== expected.serviceId
    || actual.credentialProfileId !== expected.credentialProfileId
    || actual.credentialCreatedAt !== expected.credentialCreatedAt
    || (
      expected.credentialFingerprint !== undefined
      && actual.credentialFingerprint !== expected.credentialFingerprint
    )
    || actual.selection.kind !== expected.selection.kind
  ) {
    return false;
  }
  if (expected.selection.kind === 'profile') {
    return actual.selection.kind === 'profile'
      && actual.selection.profileId === expected.selection.profileId;
  }
  return actual.selection.kind === 'group'
    && actual.selection.groupId === expected.selection.groupId
    && actual.selection.activeProfileId === expected.selection.activeProfileId
    && actual.selection.fallbackProfileId === expected.selection.fallbackProfileId;
}

export async function writeClaudeConnectedServiceHomeProvenance(params: Readonly<{
  claudeConfigDir: string;
  provenance: ClaudeConnectedServiceHomeProvenanceV1;
}>): Promise<void> {
  await writeJsonAtomic(
    resolveClaudeConnectedServiceHomeProvenancePath(params.claudeConfigDir),
    params.provenance,
  );
}

/**
 * Records the last-written macOS keychain fingerprint onto the existing home provenance without
 * disturbing the rest of it. Called only AFTER a real keychain write succeeds so the next spawn/resume
 * can skip an identical (clobbering) write. No-op if the home has no provenance yet.
 */
export async function writeClaudeConnectedServiceHomeMacOsKeychainCredentialProvenance(params: Readonly<{
  claudeConfigDir: string;
  macOsKeychainCredential: ClaudeConnectedServiceHomeMacOsKeychainCredentialProvenance;
}>): Promise<void> {
  const current = await readClaudeConnectedServiceHomeProvenance(params.claudeConfigDir);
  if (!current) return;
  await writeClaudeConnectedServiceHomeProvenance({
    claudeConfigDir: params.claudeConfigDir,
    provenance: {
      ...current,
      macOsKeychainCredential: params.macOsKeychainCredential,
    },
  });
}
