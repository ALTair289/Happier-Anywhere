import { objectKey } from '@/utils/deterministicJson';

import type {
  AcpPlanRemoval,
  AcpPlanProjectionResult,
  AcpPlanSource,
  NormalizedAcpPlanItem,
  NormalizedAcpPlanSnapshot,
} from './types';

const DEFAULT_FINALIZED_TURN_LIMIT = 256;

type TurnState = {
  sources: Partial<Record<AcpPlanSource, NormalizedAcpPlanSnapshot>>;
  lastIncomingFingerprints: Partial<Record<AcpPlanSource, string>>;
  publishedFingerprint: string | null;
};

function fingerprintSnapshot(snapshot: NormalizedAcpPlanSnapshot): string {
  return objectKey({
    providerId: snapshot.providerId,
    markdown: snapshot.markdown,
    fileUri: snapshot.fileUri,
    items: snapshot.items,
  });
}

function fingerprintIncomingSnapshot(snapshot: NormalizedAcpPlanSnapshot): string {
  return objectKey(snapshot);
}

function reindex(items: readonly NormalizedAcpPlanItem[]): NormalizedAcpPlanItem[] {
  return items.map((item, order) => ({ ...item, order }));
}

function mergeByVendorRef(
  previous: readonly NormalizedAcpPlanItem[],
  incoming: readonly NormalizedAcpPlanItem[],
): NormalizedAcpPlanItem[] {
  const merged = [...previous];
  const indexByVendorRef = new Map<string, number>();
  previous.forEach((item, index) => {
    if (item.vendorRef) indexByVendorRef.set(item.vendorRef, index);
  });
  for (const item of incoming) {
    const priorIndex = item.vendorRef ? indexByVendorRef.get(item.vendorRef) : undefined;
    if (priorIndex === undefined) {
      if (item.vendorRef) indexByVendorRef.set(item.vendorRef, merged.length);
      merged.push(item);
      continue;
    }
    merged[priorIndex] = item;
  }
  return reindex(merged);
}

function mergeSnapshot(
  previous: NormalizedAcpPlanSnapshot | undefined,
  incoming: NormalizedAcpPlanSnapshot,
): NormalizedAcpPlanSnapshot {
  if (!incoming.merge || !previous) return { ...incoming, items: reindex(incoming.items) };
  return {
    ...incoming,
    markdown: incoming.markdown ?? previous.markdown,
    items: mergeByVendorRef(previous.items, incoming.items),
  };
}

export class AcpPlanProjection {
  private readonly activeTurns = new Map<string, TurnState>();
  private readonly finalizedTurns = new Set<string>();
  private readonly finalizedOrder: string[] = [];
  private readonly publish: (snapshot: NormalizedAcpPlanSnapshot) => void | Promise<void>;
  private readonly finalizedTurnLimit: number;
  private publicationTail: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private resetInFlight: Promise<void> | null = null;

  constructor(params: Readonly<{
    publish: (snapshot: NormalizedAcpPlanSnapshot) => void | Promise<void>;
    finalizedTurnLimit?: number;
  }>) {
    this.publish = params.publish;
    this.finalizedTurnLimit = Math.max(1, Math.trunc(params.finalizedTurnLimit ?? DEFAULT_FINALIZED_TURN_LIMIT));
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get finalizedTurnCount(): number {
    return this.finalizedTurns.size;
  }

  project(incoming: NormalizedAcpPlanSnapshot): Promise<AcpPlanProjectionResult> {
    if (this.resetInFlight) return Promise.resolve({ kind: 'late' });
    const generation = this.lifecycleGeneration;
    const operation = this.publicationTail.then(() => this.projectSerial(incoming, generation));
    this.publicationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  remove(incoming: AcpPlanRemoval): Promise<AcpPlanProjectionResult> {
    if (this.resetInFlight) return Promise.resolve({ kind: 'late' });
    const generation = this.lifecycleGeneration;
    const operation = this.publicationTail.then(() => this.removeSerial(incoming, generation));
    this.publicationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async projectSerial(
    incoming: NormalizedAcpPlanSnapshot,
    generation: number,
  ): Promise<AcpPlanProjectionResult> {
    if (generation !== this.lifecycleGeneration) return { kind: 'late' };
    if (this.finalizedTurns.has(incoming.turnId)) return { kind: 'late' };
    const existingState = this.activeTurns.get(incoming.turnId);
    const state = existingState ?? {
      sources: {},
      lastIncomingFingerprints: {},
      publishedFingerprint: null,
    };
    this.activeTurns.set(incoming.turnId, state);

    const incomingFingerprint = fingerprintIncomingSnapshot(incoming);
    if (state.lastIncomingFingerprints[incoming.source] === incomingFingerprint) {
      return { kind: 'duplicate', fingerprint: state.publishedFingerprint ?? undefined };
    }
    const previousSource = state.sources[incoming.source];
    const previousIncomingFingerprint = state.lastIncomingFingerprints[incoming.source];
    state.sources[incoming.source] = mergeSnapshot(state.sources[incoming.source], incoming);
    state.lastIncomingFingerprints[incoming.source] = incomingFingerprint;
    if (incoming.source === 'standard' && state.sources.proprietary) {
      return { kind: 'shadowed', fingerprint: state.publishedFingerprint ?? undefined };
    }

    const effective = state.sources.proprietary ?? state.sources.standard;
    if (!effective) return { kind: 'shadowed' };
    const fingerprint = fingerprintSnapshot(effective);
    if (state.publishedFingerprint === fingerprint) {
      return { kind: 'duplicate', fingerprint };
    }
    try {
      await this.publish(effective);
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        if (previousSource) state.sources[incoming.source] = previousSource;
        else delete state.sources[incoming.source];
        if (previousIncomingFingerprint) {
          state.lastIncomingFingerprints[incoming.source] = previousIncomingFingerprint;
        } else {
          delete state.lastIncomingFingerprints[incoming.source];
        }
        if (!existingState) this.activeTurns.delete(incoming.turnId);
      }
      throw error;
    }
    if (generation !== this.lifecycleGeneration) return { kind: 'late' };
    state.publishedFingerprint = fingerprint;
    return { kind: 'published', fingerprint };
  }

  private async removeSerial(
    incoming: AcpPlanRemoval,
    generation: number,
  ): Promise<AcpPlanProjectionResult> {
    if (generation !== this.lifecycleGeneration) return { kind: 'late' };
    if (this.finalizedTurns.has(incoming.turnId)) return { kind: 'late' };
    const state = this.activeTurns.get(incoming.turnId);
    const currentSource = state?.sources[incoming.source];
    if (!state || !currentSource || currentSource.correlationId !== incoming.correlationId) {
      return { kind: 'duplicate', fingerprint: state?.publishedFingerprint ?? undefined };
    }

    const currentIncomingFingerprint = state.lastIncomingFingerprints[incoming.source];
    delete state.sources[incoming.source];
    delete state.lastIncomingFingerprints[incoming.source];
    const effective = state.sources.proprietary ?? state.sources.standard;
    if (effective) {
      const fingerprint = fingerprintSnapshot(effective);
      if (state.publishedFingerprint === fingerprint) {
        return { kind: 'shadowed', fingerprint };
      }
      try {
        await this.publish(effective);
      } catch (error) {
        if (generation === this.lifecycleGeneration) {
          state.sources[incoming.source] = currentSource;
          if (currentIncomingFingerprint) {
            state.lastIncomingFingerprints[incoming.source] = currentIncomingFingerprint;
          }
        }
        throw error;
      }
      if (generation !== this.lifecycleGeneration) return { kind: 'late' };
      state.publishedFingerprint = fingerprint;
      return { kind: 'published', fingerprint };
    }

    const cleared: NormalizedAcpPlanSnapshot = {
      providerId: incoming.providerId,
      turnId: incoming.turnId,
      correlationId: incoming.correlationId,
      source: incoming.source,
      merge: false,
      items: [],
    };
    const fingerprint = fingerprintSnapshot(cleared);
    if (state.publishedFingerprint === fingerprint) {
      return { kind: 'duplicate', fingerprint };
    }
    try {
      await this.publish(cleared);
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        state.sources[incoming.source] = currentSource;
        if (currentIncomingFingerprint) {
          state.lastIncomingFingerprints[incoming.source] = currentIncomingFingerprint;
        }
      }
      throw error;
    }
    if (generation !== this.lifecycleGeneration) return { kind: 'late' };
    state.publishedFingerprint = fingerprint;
    return { kind: 'published', fingerprint };
  }

  finalizeTurn(turnId: string): void {
    this.activeTurns.delete(turnId);
    if (this.finalizedTurns.has(turnId)) return;
    this.finalizedTurns.add(turnId);
    this.finalizedOrder.push(turnId);
    while (this.finalizedOrder.length > this.finalizedTurnLimit) {
      const removed = this.finalizedOrder.shift();
      if (removed) this.finalizedTurns.delete(removed);
    }
  }

  reset(): Promise<void> {
    if (this.resetInFlight) return this.resetInFlight;
    const publicationBarrier = this.publicationTail;
    this.lifecycleGeneration += 1;
    this.activeTurns.clear();
    this.finalizedTurns.clear();
    this.finalizedOrder.length = 0;
    // A publisher already in flight owns an external side effect that a post-await
    // generation check cannot undo. Reject ingress throughout this transition and
    // keep the next session lifecycle behind that side effect.
    const reset = publicationBarrier.finally(() => {
      if (this.resetInFlight === reset) this.resetInFlight = null;
    });
    this.resetInFlight = reset;
    return reset;
  }
}
