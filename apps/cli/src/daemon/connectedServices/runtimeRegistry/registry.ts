import { readConnectedServiceMaterializationIdentityV1 } from '../materialize/createConnectedServiceMaterializationIdentity';
import {
  buildConnectedServiceRuntimeIdentityKey,
  buildRuntimeActiveBindings,
  buildRuntimeBoundProfiles,
  normalizeConnectedServicesBindingsRaw,
  normalizeRuntimeRegistryEnv,
  readConnectedServiceRuntimeTargetIdentity,
  readRuntimeChildSelections,
  stableRuntimeRegistryFingerprint,
} from './identity';
import type {
  ConnectedServiceRuntimeQuotaTarget,
  ConnectedServiceRuntimeRefreshTarget,
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetInput,
  ConnectedServiceRuntimeTargetUpdate,
} from './target';

export { readConnectedServiceRuntimeTargetIdentity } from './identity';
export type {
  ConnectedServiceRuntimeBindingIdentity,
  ConnectedServiceRuntimeBoundProfile,
  ConnectedServiceRuntimeQuotaTarget,
  ConnectedServiceRuntimeRefreshTarget,
  ConnectedServicesRuntimeBindingsV1Like,
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetInput,
  ConnectedServiceRuntimeTargetUpdate,
} from './target';
export type { ConnectedServiceRuntimeIdentity } from './identity';

type IndexedTarget = Readonly<{
  target: ConnectedServiceRuntimeTarget;
  fingerprint: string;
}>;

function normalizePid(pidRaw: number): number | null {
  const pid = Math.trunc(Number(pidRaw));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildTargetFingerprint(target: Omit<ConnectedServiceRuntimeTarget, 'revision'>): string {
  return stableRuntimeRegistryFingerprint(target);
}

function omitRevision(target: ConnectedServiceRuntimeTarget): Omit<ConnectedServiceRuntimeTarget, 'revision'> {
  const {
    revision: _revision,
    ...withoutRevision
  } = target;
  return withoutRevision;
}

export class ConnectedServiceRuntimeRegistry {
  private readonly targetsByPid = new Map<number, IndexedTarget>();
  private readonly pidBySessionId = new Map<string, number>();

  public registerTarget(input: ConnectedServiceRuntimeTargetInput): ConnectedServiceRuntimeTarget {
    const existing = this.getIndexedByPid(input.pid);
    return this.writeTarget(input.pid, input, existing?.target ?? null);
  }

  public updateTarget(input: ConnectedServiceRuntimeTargetUpdate): ConnectedServiceRuntimeTarget | null {
    const existing = this.getIndexedByPid(input.pid);
    if (!existing) return null;
    return this.writeTarget(input.pid, input, existing.target);
  }

  public adoptSessionId(input: Readonly<{ pid: number; sessionId?: string | null }>): ConnectedServiceRuntimeTarget | null {
    return this.updateTarget({
      pid: input.pid,
      sessionId: input.sessionId ?? null,
    });
  }

  public unregisterPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    const existing = this.targetsByPid.get(pid);
    if (!existing) return null;
    this.targetsByPid.delete(pid);
    this.deleteSessionIndex(existing.target);
    return existing.target;
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): ConnectedServiceRuntimeTarget | null {
    const fromPid = normalizePid(fromPidRaw);
    const toPid = normalizePid(toPidRaw);
    if (fromPid === null || toPid === null) return null;
    const existing = this.targetsByPid.get(fromPid);
    if (!existing) return null;
    if (fromPid === toPid) return existing.target;

    const replaced = this.targetsByPid.get(toPid);
    if (replaced) {
      this.deleteSessionIndex(replaced.target);
    }

    const nextBase = {
      ...existing.target,
      pid: toPid,
      revision: existing.target.revision + 1,
    };
    const fingerprint = buildTargetFingerprint(omitRevision(nextBase));
    this.targetsByPid.delete(fromPid);
    this.deleteSessionIndex(existing.target);
    const next = nextBase as ConnectedServiceRuntimeTarget;
    this.targetsByPid.set(toPid, { target: next, fingerprint });
    this.indexSession(next);
    return next;
  }

  public getByPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    return this.getIndexedByPid(pidRaw)?.target ?? null;
  }

  public getBySessionId(sessionIdRaw: string): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(sessionIdRaw);
    if (!sessionId) return null;
    const pid = this.pidBySessionId.get(sessionId);
    return typeof pid === 'number' ? this.getByPid(pid) : null;
  }

  public listTargets(): ReadonlyArray<ConnectedServiceRuntimeTarget> {
    return Array.from(this.targetsByPid.values())
      .map((entry) => entry.target)
      .sort((left, right) => left.pid - right.pid);
  }

  public listRefreshTargets(): ReadonlyArray<ConnectedServiceRuntimeRefreshTarget> {
    return this.listTargets().flatMap((target) => {
      if (!target.agentId || !target.materializationKey || target.boundProfiles.length === 0) {
        return [];
      }
      const view: ConnectedServiceRuntimeRefreshTarget = {
        ...target,
        agentId: target.agentId,
        materializationKey: target.materializationKey,
        bindings: target.boundProfiles,
        selectionsByServiceId: new Map(target.connectedServiceSelections.map((selection) => [selection.serviceId, selection])),
      };
      return [view];
    });
  }

  public listQuotaTargets(): ReadonlyArray<ConnectedServiceRuntimeQuotaTarget> {
    return this.listTargets().flatMap((target) => {
      if (target.boundProfiles.length === 0 && target.activeBindings.length === 0) {
        return [];
      }
      const view: ConnectedServiceRuntimeQuotaTarget = {
        ...target,
        bindings: target.connectedServicesBindingsRaw,
        connectedServiceSelectionsEnv: target.connectedServiceSelectionsEnv,
        runtimeAccountIdentitySelections: target.runtimeAccountIdentitySelections,
      };
      return [view];
    });
  }

  private getIndexedByPid(pidRaw: number): IndexedTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    return this.targetsByPid.get(pid) ?? null;
  }

  private writeTarget(
    pidRaw: number,
    patch: ConnectedServiceRuntimeTargetInput | ConnectedServiceRuntimeTargetUpdate,
    previousAtPid: ConnectedServiceRuntimeTarget | null,
  ): ConnectedServiceRuntimeTarget {
    const pid = normalizePid(pidRaw) ?? 0;
    const provisionalSessionId = patch.sessionId !== undefined
      ? normalizeString(patch.sessionId)
      : previousAtPid?.sessionId ?? null;
    const previousSessionPid = provisionalSessionId ? this.pidBySessionId.get(provisionalSessionId) : undefined;
    const previousForSameSession = typeof previousSessionPid === 'number' && previousSessionPid !== pid
      ? this.targetsByPid.get(previousSessionPid)?.target ?? null
      : null;
    const previous = previousAtPid ?? previousForSameSession;
    const connectedServiceSelectionsEnv = patch.connectedServiceSelectionsEnv !== undefined
      ? normalizeRuntimeRegistryEnv(patch.connectedServiceSelectionsEnv)
      : previous?.connectedServiceSelectionsEnv ?? {};
    const connectedServiceSelections = readRuntimeChildSelections(connectedServiceSelectionsEnv);
    const connectedServicesBindingsRaw = patch.connectedServicesBindingsRaw !== undefined
      ? normalizeConnectedServicesBindingsRaw(patch.connectedServicesBindingsRaw)
      : previous?.connectedServicesBindingsRaw ?? {};
    const agentId = patch.agentId !== undefined ? patch.agentId ?? null : previous?.agentId ?? null;
    const sessionId = patch.sessionId !== undefined ? normalizeString(patch.sessionId) : previous?.sessionId ?? null;
    const materializationKey = patch.materializationKey !== undefined
      ? normalizeString(patch.materializationKey)
      : previous?.materializationKey ?? null;
    const connectedServiceMaterializationIdentityV1 = patch.connectedServiceMaterializationIdentityV1 !== undefined
      ? readConnectedServiceMaterializationIdentityV1(patch.connectedServiceMaterializationIdentityV1)
      : previous?.connectedServiceMaterializationIdentityV1 ?? null;
    const sessionDirectory = patch.sessionDirectory !== undefined
      ? normalizeString(patch.sessionDirectory)
      : previous?.sessionDirectory ?? null;
    const runtimeAccountIdentitySelections = patch.runtimeAccountIdentitySelections !== undefined
      ? Array.from(patch.runtimeAccountIdentitySelections ?? [])
      : previous?.runtimeAccountIdentitySelections ?? [];
    const boundProfiles = buildRuntimeBoundProfiles({
      connectedServicesBindingsRaw,
      connectedServiceSelections,
    });
    const activeBindings = buildRuntimeActiveBindings({
      connectedServicesBindingsRaw,
      connectedServiceSelections,
    });
    const identity = readConnectedServiceRuntimeTargetIdentity({
      pid,
      sessionId,
      agentId,
      materializationKey,
      activeBindings,
    });
    const base = {
      pid,
      agentId,
      sessionId,
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      connectedServiceSelections,
      materializationKey,
      connectedServiceMaterializationIdentityV1,
      sessionDirectory,
      runtimeAccountIdentitySelections,
      boundProfiles,
      activeBindings,
      runtimeIdentityKey: buildConnectedServiceRuntimeIdentityKey(identity),
    };
    const fingerprint = buildTargetFingerprint(base);
    if (previous) {
      const previousIndexed = this.targetsByPid.get(previous.pid);
      if (previousIndexed?.fingerprint === fingerprint) {
        return previous;
      }
    }

    const next: ConnectedServiceRuntimeTarget = {
      ...base,
      revision: (previous?.revision ?? 0) + 1,
    };
    if (previousAtPid) {
      this.deleteSessionIndex(previousAtPid);
    }
    if (previousForSameSession) {
      this.targetsByPid.delete(previousForSameSession.pid);
      this.deleteSessionIndex(previousForSameSession);
    }
    this.targetsByPid.set(pid, { target: next, fingerprint });
    this.indexSession(next);
    return next;
  }

  private deleteSessionIndex(target: ConnectedServiceRuntimeTarget): void {
    if (!target.sessionId) return;
    if (this.pidBySessionId.get(target.sessionId) === target.pid) {
      this.pidBySessionId.delete(target.sessionId);
    }
  }

  private indexSession(target: ConnectedServiceRuntimeTarget): void {
    if (!target.sessionId) return;
    this.pidBySessionId.set(target.sessionId, target.pid);
  }
}
