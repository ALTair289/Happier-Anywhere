import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { getConnectedServiceMaterializer } from '@/backends/catalog';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  serializeConnectedServiceMaterializedEnvKeys,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import type { ConnectedServicesMaterializeResult } from './providerMaterializerTypes';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

export type ConnectedServiceResolvedSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      record: ConnectedServiceCredentialRecordV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      record: ConnectedServiceCredentialRecordV1;
      policy: unknown;
    }>;

const activeMaterializationAttemptByRootDir = new Map<string, string>();
const materializationPromotionTailByRootDir = new Map<string, Promise<void>>();

export class ConnectedServiceMaterializationSupersededError extends Error {
  readonly code = 'connected_service_materialization_superseded';

  constructor(rootDir: string) {
    super(`Connected-service materialization for ${rootDir} was superseded by a newer attempt`);
    this.name = 'ConnectedServiceMaterializationSupersededError';
  }
}

function bestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
}

function forgetActiveAttemptIfCurrent(rootDir: string, attemptId: string): void {
  if (activeMaterializationAttemptByRootDir.get(rootDir) === attemptId) {
    activeMaterializationAttemptByRootDir.delete(rootDir);
  }
}

function assertActiveAttempt(params: Readonly<{
  rootDir: string;
  attemptId: string;
  cleanupRoot: () => void;
}>): void {
  if (activeMaterializationAttemptByRootDir.get(params.rootDir) === params.attemptId) {
    return;
  }
  params.cleanupRoot();
  throw new ConnectedServiceMaterializationSupersededError(params.rootDir);
}

async function runSerializedPromotion<T>(
  rootDir: string,
  promote: () => Promise<T>,
): Promise<T> {
  const previousTail = materializationPromotionTailByRootDir.get(rootDir) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentTailSegment = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail.catch(() => {}).then(() => currentTailSegment);
  materializationPromotionTailByRootDir.set(rootDir, currentTail);

  await previousTail.catch(() => {});
  try {
    return await promote();
  } finally {
    releaseCurrent();
    if (materializationPromotionTailByRootDir.get(rootDir) === currentTail) {
      materializationPromotionTailByRootDir.delete(rootDir);
    }
  }
}

function rewriteEnvRoot(
  env: Readonly<Record<string, string>>,
  fromRoot: string,
  toRoot: string,
): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const rel = relative(fromRoot, value);
    rewritten[key] = rel === ''
      ? toRoot
      : !rel.startsWith('..') && !isAbsolute(rel)
        ? join(toRoot, rel)
        : value;
  }
  return rewritten;
}

function rewritePathRoot(
  value: string,
  fromRoot: string,
  toRoot: string,
): string {
  const rel = relative(fromRoot, value);
  return rel === ''
    ? toRoot
    : !rel.startsWith('..') && !isAbsolute(rel)
      ? join(toRoot, rel)
      : value;
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
}>): Promise<ConnectedServicesMaterializeResult | null> {
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: params.baseDir,
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    materializationIdentity: params.connectedServiceMaterializationIdentityV1 ?? null,
  });
  // `rootDir` is `<baseDir>/<segment>/<agentId>`; recover the segment for the sibling attempt dir.
  const materializationSegment = basename(dirname(rootDir));
  const attemptRoot = join(params.baseDir, '.attempts', `${materializationSegment}-${params.agentId}-${randomUUID()}`);
  const attemptId = attemptRoot;
  activeMaterializationAttemptByRootDir.set(rootDir, attemptId);
  const cleanupRoot = bestEffortCleanupDirectory(attemptRoot);

  const materializer = await getConnectedServiceMaterializer(params.agentId);
  if (!materializer) {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }
  await mkdir(attemptRoot, { recursive: true });
  let materialized: ConnectedServicesMaterializeResult | null;
  try {
    materialized = await materializer({
      agentId: params.agentId,
      activeServerDir: params.activeServerDir,
      rootDir: attemptRoot,
      sessionDirectory: params.sessionDirectory ?? null,
      recordsByServiceId: params.recordsByServiceId,
      selectionsByServiceId: params.selectionsByServiceId,
      accountSettings: params.accountSettings ?? null,
      processEnv: params.processEnv ?? process.env,
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      cleanupRoot,
    });
  } catch (error) {
    cleanupRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw error;
  }
  if (!materialized) {
    cleanupRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }
  const materializedEnv = rewriteEnvRoot(materialized.env, attemptRoot, rootDir);
  const explicitTargetMaterializedRoot = typeof materialized.targetMaterializedRoot === 'string'
    && materialized.targetMaterializedRoot.trim().length > 0
    ? rewritePathRoot(materialized.targetMaterializedRoot, attemptRoot, rootDir)
    : null;
  const serializedSelections = serializeConnectedServiceChildSelections(params.selectionsByServiceId);
  const serializedMaterializedEnvKeys = serializeConnectedServiceMaterializedEnvKeys(materializedEnv);
  const targetMaterializedRoot = explicitTargetMaterializedRoot ?? resolveConnectedServiceTargetMaterializedRoot({
    agentId: params.agentId,
    targetMaterializedEnv: materializedEnv,
  }) ?? (materialized.cleanupOnFailure ? rootDir : null);
  try {
    await runSerializedPromotion(rootDir, async () => {
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
      await replaceDirectoryAtomically({
        stagedDir: attemptRoot,
        targetDir: rootDir,
        afterPromote: async () => {
          await materialized.afterPromote?.({
            env: materializedEnv,
            targetMaterializedRoot,
            finalRootDir: rootDir,
          });
          assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
        },
      });
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
    });
    assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
    const cleanupFinalRoot = bestEffortCleanupDirectory(rootDir);
    const cleanupOnFailure = materialized.cleanupOnFailure ? cleanupFinalRoot : materialized.cleanupOnFailure;
    const cleanupOnExit = materialized.cleanupOnExit ? cleanupFinalRoot : materialized.cleanupOnExit;
    return {
      ...materialized,
      cleanupOnFailure,
      cleanupOnExit,
      env: {
        ...materializedEnv,
        ...(targetMaterializedRoot
          ? { [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: targetMaterializedRoot }
          : null),
        ...(serializedSelections
          ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializedSelections }
          : null),
        ...(serializedMaterializedEnvKeys
          ? { [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: serializedMaterializedEnvKeys }
          : null),
      },
    };
  } finally {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
  }
}
