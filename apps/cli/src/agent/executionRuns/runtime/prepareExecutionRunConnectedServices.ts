import { randomUUID } from 'node:crypto';

import type { BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

import {
  materializeDaemonConnectedServicesForExecutionRun,
  releaseDaemonConnectedServicesForExecutionRun,
} from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import { resolveSessionAgentSpawnConnectedServicesDefaults } from '@/session/services/spawn/normalizeSessionAgentSpawnActionRequest';
import { logger } from '@/ui/logger';

/**
 * Runner-side owner of the ER-CS start flow: resolve the run's effective connected-services selection
 * and, when one exists, ask the DAEMON bridge to materialize it for a run-scoped key. Returns the env
 * to merge into the run's isolation bundle plus an idempotent `cleanup` that releases the daemon-side
 * registration + root at run end.
 *
 * Selection resolution (QA2-F02 root cause): an explicit per-target selection wins; otherwise the run
 * defaults through `resolveSessionAgentSpawnConnectedServicesDefaults` — the SAME owner sessions use
 * at spawn (fresh blocking settings bootstrap). The runner's in-process settings snapshot is NOT
 * consulted: it is a second, potentially stale settings surface whose empty/partial state silently
 * killed defaulting on a live run (G5 failure). One defaulting owner, one settings path.
 *
 * Observability (QA2-F03): every run start emits exactly one info-level decision line — materialized
 * (env key NAMES + key/source), proceeding native, or failing closed. Never token/secret values.
 *
 * Fail-closed: when a selection EXISTS but the bridge cannot deliver it, this throws a typed error —
 * the run must never silently start on the runner's inherited (wrong) account. When no selection
 * exists at all, it returns null and the run keeps default behavior (logged).
 */

export class ExecutionRunConnectedServicesUnavailableError extends Error {
  readonly code = 'execution_run_connected_services_unavailable' as const;
  readonly agentId: string;
  readonly cause?: unknown;

  constructor(params: Readonly<{ agentId: string; cause?: unknown }>) {
    super(`Connected services are selected for this run but could not be materialized (${params.agentId})`);
    this.name = 'ExecutionRunConnectedServicesUnavailableError';
    this.agentId = params.agentId;
    this.cause = params.cause;
  }
}

export type PreparedExecutionRunConnectedServices = Readonly<{
  env: Readonly<Record<string, string>>;
  materializationKey: string;
  cleanup: () => Promise<void>;
}>;

type MaterializeViaDaemon = typeof materializeDaemonConnectedServicesForExecutionRun;
type ReleaseViaDaemon = (
  body: Readonly<{ runId: string; pid: number; materializationKey: string }>,
) => Promise<boolean>;
type ResolveSessionSpawnDefaults = (params: Readonly<{
  backendTarget: BackendTargetRefV1 & { kind: 'builtInAgent' };
  credentials: Credentials;
}>) => Promise<Readonly<{ connectedServices: ConnectedServiceBindingsV1 }> | null>;

type ResolvedRunSelection = Readonly<{
  bindings: ConnectedServiceBindingsV1;
  source: 'explicit' | 'session_default';
}> | null;

function hasConnectedBinding(bindings: ConnectedServiceBindingsV1): boolean {
  return Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

async function resolveRunSelection(params: Readonly<{
  backendTarget: BackendTargetRefV1 & { kind: 'builtInAgent' };
  explicitBindings: unknown;
  credentials: Credentials | null;
  resolveSessionSpawnDefaults: ResolveSessionSpawnDefaults;
}>): Promise<ResolvedRunSelection> {
  if (params.explicitBindings !== undefined && params.explicitBindings !== null) {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(params.explicitBindings);
    if (parsed.success) {
      // A valid explicit selection is authoritative — including "all native" (the caller opted out).
      return hasConnectedBinding(parsed.data)
        ? { bindings: parsed.data, source: 'explicit' }
        : null;
    }
    // Malformed explicit selection: never guess an account from garbage — fall through to the
    // account default (which itself fails closed to null when unset).
    logger.warn('[EXECUTION RUN] connected services: malformed explicit selection ignored; falling back to account default', {
      agentId: params.backendTarget.agentId,
    });
  }

  if (!params.credentials) return null;
  const resolved = await params.resolveSessionSpawnDefaults({
    backendTarget: params.backendTarget,
    credentials: params.credentials,
  });
  if (!resolved) return null;
  return { bindings: resolved.connectedServices, source: 'session_default' };
}

export async function prepareExecutionRunConnectedServices(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  /** Optional explicit per-target selection from the run-start request. */
  connectedServices?: unknown;
  /** Runner credentials — required for account-default resolution (the session owner bootstraps settings). */
  credentials: Credentials | null;
  cwd: string;
  sessionId: string;
  /** Boundary injection points; default to the canonical control client + session defaulting owner. */
  materializeViaDaemon?: MaterializeViaDaemon;
  releaseViaDaemon?: ReleaseViaDaemon;
  resolveSessionSpawnDefaults?: ResolveSessionSpawnDefaults;
}>): Promise<PreparedExecutionRunConnectedServices | null> {
  if (params.backendTarget.kind !== 'builtInAgent') return null;
  const backendTarget = params.backendTarget;
  const agentId = backendTarget.agentId;

  const selection = await resolveRunSelection({
    backendTarget,
    explicitBindings: params.connectedServices,
    credentials: params.credentials,
    resolveSessionSpawnDefaults: params.resolveSessionSpawnDefaults
      ?? resolveSessionAgentSpawnConnectedServicesDefaults,
  });
  if (!selection) {
    // QA2-F03: the one decision line for the native path — a run silently starting on the
    // runner-inherited account must always be diagnosable from the log.
    logger.info('[EXECUTION RUN] connected services: no selection resolved; proceeding native', {
      agentId,
      hadExplicitSelection: params.connectedServices !== undefined && params.connectedServices !== null,
      hadCredentials: params.credentials !== null,
    });
    return null;
  }

  const materialize = params.materializeViaDaemon ?? materializeDaemonConnectedServicesForExecutionRun;
  const release = params.releaseViaDaemon
    ?? (async (body: Readonly<{ runId: string; pid: number; materializationKey: string }>) =>
      await releaseDaemonConnectedServicesForExecutionRun(body));

  // Run-scoped materialization key. The manager allocates the public runId later; the key only needs
  // to be run-unique and stable between materialize and release, so it carries its own id.
  const materializationKey = `execution_run:${randomUUID()}`;

  let released = false;
  const cleanup = async () => {
    if (released) return;
    released = true;
    try {
      await release({ runId: materializationKey, pid: process.pid, materializationKey });
    } catch (error) {
      // Best-effort: a failed release must not fail run teardown.
      logger.debug('[EXECUTION RUN] Connected-services release failed (non-fatal)', error);
    }
  };

  let materialized: Awaited<ReturnType<MaterializeViaDaemon>>;
  try {
    materialized = await materialize({
      runId: materializationKey,
      agentId,
      pid: process.pid,
      materializationKey,
      connectedServicesBindingsRaw: selection.bindings,
      sessionDirectory: params.cwd,
      sessionId: params.sessionId,
    });
  } catch (error) {
    logger.warn('[EXECUTION RUN] connected services: materialization FAILED; failing run start closed', {
      agentId,
      source: selection.source,
      materializationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    // A1: the daemon may have SUCCEEDED after the client abandoned the call (transport timeout) —
    // fire the idempotent release for the run key so a late daemon-side root + registered target are
    // always reclaimed. Best-effort by construction (cleanup swallows its own failures).
    await cleanup();
    throw new ExecutionRunConnectedServicesUnavailableError({ agentId, cause: error });
  }

  const envKeys = Object.keys(materialized.env ?? {});
  if (envKeys.length === 0) {
    // Unexpected with the fail-closed bridge (it throws when nothing resolves), but never leave a
    // daemon-side registration behind for a run that proceeds native.
    await cleanup();
    logger.info('[EXECUTION RUN] connected services: bridge returned no env; proceeding native', {
      agentId,
      source: selection.source,
      materializationKey,
    });
    return null;
  }

  // QA2-F03: the one decision line for the materialized path. Env key NAMES only — values are paths
  // into the materialized root and stay out of logs anyway; tokens never appear in env at all.
  logger.info('[EXECUTION RUN] connected services: materialized', {
    agentId,
    source: selection.source,
    materializationKey,
    envKeys,
  });

  return {
    env: materialized.env,
    materializationKey,
    cleanup,
  };
}
