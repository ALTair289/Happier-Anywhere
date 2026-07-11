import {
  SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT,
  SESSION_RUNTIME_ACTIVITY_RECEIPT_LIMIT,
  SESSION_RUNTIME_ACTIVITY_RECEIPT_RETENTION_LIMIT,
  SESSION_RUNTIME_ACTIVITY_TERMINAL_OCCURRENCE_LIMIT,
  SessionRuntimeActivityRevisionSchema,
  SessionRuntimeActivityRequestDigestSchema,
  type SessionRuntimeActivityRequestDigest,
} from './sessionRuntimeActivityIdentity.js';
import type {
  SessionRuntimeActivityActiveLifecycleStateV2,
  SessionRuntimeActivityMutationAckStatusV2,
  SessionRuntimeActivityMutationAckV2,
  SessionRuntimeActivityMutationV2,
  SessionRuntimeActivityProjectionV2,
  SessionRuntimeActivitySourceClassV2,
  SessionRuntimeActivitySourceKindV2,
  SessionRuntimeActivityTerminalLifecycleStateV2,
} from './sessionRuntimeActivityV2.js';
import {
  SessionRuntimeActivityExpectedOwnerManifestV2Schema,
} from './sessionRuntimeActivityV2.js';
import { SessionRuntimeActivityWriterGenerationSchema } from './sessionRuntimeActivityIdentity.js';

type SourceCertainty = 'authoritative' | 'last-known';

type ActiveOccurrence = Readonly<{
  occurrenceId: string;
  sourceKind: SessionRuntimeActivitySourceKindV2;
  lifecycleState: SessionRuntimeActivityActiveLifecycleStateV2;
  certainty: SourceCertainty;
  lastOwnerSequence: number;
}>;

type TerminalOccurrence = Readonly<{
  occurrenceId: string;
  terminalState: SessionRuntimeActivityTerminalLifecycleStateV2;
  lastOwnerSequence: number;
}>;

type SourceState = Readonly<{
  sourceKey: string;
  active: ActiveOccurrence | null;
  terminalOccurrences: readonly TerminalOccurrence[];
}>;

type OwnerState = Readonly<{
  ownerScope: string;
  state: 'active' | 'idle' | 'unknown';
  ownerSequence: number;
  lowWatermark: number;
  sources: readonly SourceState[];
}>;

type MutationReceipt = Readonly<{
  mutationId: string;
  requestDigest: SessionRuntimeActivityRequestDigest;
  ownerScope: string;
  ownerSequence: number;
  ack: SessionRuntimeActivityMutationAckV2;
}>;

export type SessionRuntimeActivityReducerStateV2 = Readonly<{
  v: 2;
  sessionId: string;
  writerGeneration: string;
  owners: readonly OwnerState[];
  receipts: readonly MutationReceipt[];
  projection: SessionRuntimeActivityProjectionV2;
}>;

export type ApplySessionRuntimeActivityMutationV2Options = Readonly<{
  requestDigest: string;
  observedAtMs?: number;
}>;

export type ApplySessionRuntimeActivityMutationV2Result = Readonly<{
  state: SessionRuntimeActivityReducerStateV2;
  ack: SessionRuntimeActivityMutationAckV2;
}>;

function countTerminalOccurrences(owner: OwnerState): number {
  return owner.sources.reduce((sum, source) => sum + source.terminalOccurrences.length, 0);
}

function addTerminalOccurrence(
  source: SourceState,
  occurrence: TerminalOccurrence,
): SourceState {
  const existingIndex = source.terminalOccurrences.findIndex((item) => item.occurrenceId === occurrence.occurrenceId);
  const terminalOccurrences = existingIndex < 0
    ? [...source.terminalOccurrences, occurrence]
    : source.terminalOccurrences.map((item, index) => index === existingIndex ? occurrence : item);
  return { ...source, terminalOccurrences };
}

function markOwnerUnknown(owner: OwnerState, ownerSequence: number): OwnerState {
  return {
    ...owner,
    state: 'unknown',
    ownerSequence,
    sources: owner.sources.map((source) => ({
      ...source,
      active: source.active ? { ...source.active, certainty: 'last-known', lastOwnerSequence: ownerSequence } : null,
    })),
  };
}

function activeAuthoritativeOccurrences(owner: OwnerState): readonly ActiveOccurrence[] {
  return owner.sources.flatMap((source) => source.active?.certainty === 'authoritative' ? [source.active] : []);
}

function sourceClassFromKinds(kinds: readonly SessionRuntimeActivitySourceKindV2[]): SessionRuntimeActivitySourceClassV2 | null {
  const unique = [...new Set(kinds)];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] ?? null : 'mixed';
}

function deriveProjectionMeaning(state: SessionRuntimeActivityReducerStateV2): Pick<SessionRuntimeActivityProjectionV2, 'state' | 'activeCount' | 'sourceClass'> {
  const active = state.owners.flatMap(activeAuthoritativeOccurrences);
  if (active.length > 0) {
    return {
      state: 'active',
      activeCount: active.length,
      sourceClass: sourceClassFromKinds(active.map((occurrence) => occurrence.sourceKind)),
    };
  }
  if (state.owners.some((owner) => owner.state === 'unknown')) {
    return { state: 'unknown', activeCount: 0, sourceClass: null };
  }
  return { state: 'idle', activeCount: 0, sourceClass: null };
}

function refreshProjection(
  state: SessionRuntimeActivityReducerStateV2,
  observedAtMs: number | undefined,
): SessionRuntimeActivityReducerStateV2 {
  const meaning = deriveProjectionMeaning(state);
  const current = state.projection;
  const changed = current.state !== meaning.state
    || current.activeCount !== meaning.activeCount
    || current.sourceClass !== meaning.sourceClass;
  if (!changed) return state;
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Session runtime activity revision exhausted');
  }
  return {
    ...state,
    projection: {
      v: 2,
      ...meaning,
      observedAtMs: Number.isSafeInteger(observedAtMs) && (observedAtMs ?? -1) >= 0
        ? observedAtMs ?? null
        : current.observedAtMs,
      revision: current.revision + 1,
    },
  };
}

function buildAck(
  mutation: SessionRuntimeActivityMutationV2,
  status: SessionRuntimeActivityMutationAckStatusV2,
  ownerSequence: number,
  projection: SessionRuntimeActivityProjectionV2,
): SessionRuntimeActivityMutationAckV2 {
  return {
    v: 2,
    mutationId: mutation.mutationId,
    status,
    writerGeneration: mutation.writerGeneration,
    ownerSequence,
    projection,
  };
}

function replaceOwner(
  state: SessionRuntimeActivityReducerStateV2,
  owner: OwnerState,
): SessionRuntimeActivityReducerStateV2 {
  return {
    ...state,
    owners: state.owners.map((candidate) => candidate.ownerScope === owner.ownerScope ? owner : candidate),
  };
}

function withReceipt(
  state: SessionRuntimeActivityReducerStateV2,
  mutation: SessionRuntimeActivityMutationV2,
  requestDigest: string,
  ack: SessionRuntimeActivityMutationAckV2,
): SessionRuntimeActivityReducerStateV2 {
  return {
    ...state,
    receipts: [...state.receipts, {
      mutationId: mutation.mutationId,
      requestDigest,
      ownerScope: mutation.ownerScope,
      ownerSequence: mutation.ownerSequence,
      ack,
    }],
  };
}

function consumeUnknown(
  state: SessionRuntimeActivityReducerStateV2,
  owner: OwnerState,
  mutation: SessionRuntimeActivityMutationV2,
  options: ApplySessionRuntimeActivityMutationV2Options,
  status: 'reconciliation-required' | 'bounds-exceeded',
): ApplySessionRuntimeActivityMutationV2Result {
  let next = replaceOwner(state, markOwnerUnknown(owner, mutation.ownerSequence));
  next = refreshProjection(next, options.observedAtMs);
  const ack = buildAck(mutation, status, mutation.ownerSequence, next.projection);
  return { state: withReceipt(next, mutation, options.requestDigest, ack), ack };
}

function applySourceUpsert(owner: OwnerState, mutation: SessionRuntimeActivityMutationV2): OwnerState | 'resurrection' | 'bounds' {
  if (mutation.operation.type !== 'source-upsert') return owner;
  const operation = mutation.operation;
  const source = owner.sources.find((item) => item.sourceKey === operation.sourceKey);
  if (source?.terminalOccurrences.some((item) => item.occurrenceId === operation.occurrenceId)) return 'resurrection';
  const activeCount = owner.sources.filter((item) => item.active?.certainty === 'authoritative').length;
  if (!source?.active && activeCount >= SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT) return 'bounds';
  const replacesOccurrence = source?.active && source.active.occurrenceId !== operation.occurrenceId;
  const needsReplacementTombstone = replacesOccurrence
    && !source.terminalOccurrences.some((item) => item.occurrenceId === source.active?.occurrenceId);
  if (needsReplacementTombstone && countTerminalOccurrences(owner) >= SESSION_RUNTIME_ACTIVITY_TERMINAL_OCCURRENCE_LIMIT) {
    return 'bounds';
  }
  const retainedSource = needsReplacementTombstone && source?.active
    ? addTerminalOccurrence(source, {
        occurrenceId: source.active.occurrenceId,
        terminalState: 'interrupted',
        lastOwnerSequence: mutation.ownerSequence,
      })
    : source;
  const nextSource: SourceState = {
    sourceKey: operation.sourceKey,
    active: {
      occurrenceId: operation.occurrenceId,
      sourceKind: operation.sourceKind,
      lifecycleState: operation.lifecycleState,
      certainty: 'authoritative',
      lastOwnerSequence: mutation.ownerSequence,
    },
    terminalOccurrences: retainedSource?.terminalOccurrences ?? [],
  };
  const sources = source
    ? owner.sources.map((item) => item.sourceKey === operation.sourceKey ? nextSource : item)
    : [...owner.sources, nextSource];
  return {
    ...owner,
    state: owner.state === 'unknown' ? 'unknown' : 'active',
    ownerSequence: mutation.ownerSequence,
    sources,
  };
}

function applySourceTerminal(owner: OwnerState, mutation: SessionRuntimeActivityMutationV2): OwnerState | 'bounds' {
  if (mutation.operation.type !== 'source-terminal') return owner;
  const operation = mutation.operation;
  const existing = owner.sources.find((item) => item.sourceKey === operation.sourceKey);
  const source: SourceState = existing ?? { sourceKey: operation.sourceKey, active: null, terminalOccurrences: [] };
  const isNewTombstone = !source.terminalOccurrences.some((item) => item.occurrenceId === operation.occurrenceId);
  if (isNewTombstone && countTerminalOccurrences(owner) >= SESSION_RUNTIME_ACTIVITY_TERMINAL_OCCURRENCE_LIMIT) return 'bounds';
  const terminalized = addTerminalOccurrence({
    ...source,
    active: source.active?.occurrenceId === operation.occurrenceId ? null : source.active,
  }, {
    occurrenceId: operation.occurrenceId,
    terminalState: operation.terminalState,
    lastOwnerSequence: mutation.ownerSequence,
  });
  const sources = existing
    ? owner.sources.map((item) => item.sourceKey === operation.sourceKey ? terminalized : item)
    : [...owner.sources, terminalized];
  const hasAuthoritativeActive = sources.some((item) => item.active?.certainty === 'authoritative');
  return {
    ...owner,
    state: hasAuthoritativeActive ? 'active' : owner.state === 'unknown' ? 'unknown' : 'idle',
    ownerSequence: mutation.ownerSequence,
    sources,
  };
}

function applyOwnerReconcile(owner: OwnerState, mutation: SessionRuntimeActivityMutationV2): OwnerState | 'resurrection' | 'bounds' {
  if (mutation.operation.type !== 'owner-reconcile') return owner;
  const incoming = mutation.operation.activeSources;
  const incomingKeys = new Set<string>();
  for (const source of incoming) {
    if (incomingKeys.has(source.sourceKey)) return 'resurrection';
    incomingKeys.add(source.sourceKey);
    const existing = owner.sources.find((item) => item.sourceKey === source.sourceKey);
    if (existing?.terminalOccurrences.some((item) => item.occurrenceId === source.occurrenceId)) return 'resurrection';
  }
  if (incoming.length > SESSION_RUNTIME_ACTIVITY_ACTIVE_SOURCE_LIMIT) return 'bounds';

  let terminalCount = countTerminalOccurrences(owner);
  const omittedActive = owner.sources.filter((source) => source.active && !incomingKeys.has(source.sourceKey));
  const replacedActive = incoming.flatMap((incomingSource) => {
    const existing = owner.sources.find((source) => source.sourceKey === incomingSource.sourceKey);
    return existing?.active && existing.active.occurrenceId !== incomingSource.occurrenceId ? [existing] : [];
  });
  for (const source of [...omittedActive, ...replacedActive]) {
    if (source.active && !source.terminalOccurrences.some((item) => item.occurrenceId === source.active?.occurrenceId)) {
      terminalCount += 1;
    }
  }
  if (terminalCount > SESSION_RUNTIME_ACTIVITY_TERMINAL_OCCURRENCE_LIMIT) return 'bounds';

  const byKey = new Map(owner.sources.map((source) => [source.sourceKey, source]));
  for (const source of [...omittedActive, ...replacedActive]) {
    if (!source.active) continue;
    byKey.set(source.sourceKey, addTerminalOccurrence({ ...source, active: null }, {
      occurrenceId: source.active.occurrenceId,
      terminalState: 'interrupted',
      lastOwnerSequence: mutation.ownerSequence,
    }));
  }
  for (const source of incoming) {
    const existing = byKey.get(source.sourceKey);
    byKey.set(source.sourceKey, {
      sourceKey: source.sourceKey,
      active: {
        occurrenceId: source.occurrenceId,
        sourceKind: source.sourceKind,
        lifecycleState: source.lifecycleState,
        certainty: 'authoritative',
        lastOwnerSequence: mutation.ownerSequence,
      },
      terminalOccurrences: existing?.terminalOccurrences ?? [],
    });
  }
  return {
    ...owner,
    state: incoming.length > 0 ? 'active' : 'idle',
    ownerSequence: mutation.ownerSequence,
    sources: [...byKey.values()],
  };
}

function applyOwnerTerminal(owner: OwnerState, mutation: SessionRuntimeActivityMutationV2): OwnerState | 'bounds' {
  if (mutation.operation.type !== 'owner-terminal' && mutation.operation.type !== 'owner-not-applicable') return owner;
  const additionalTombstones = owner.sources.filter((source) => source.active
    && !source.terminalOccurrences.some((item) => item.occurrenceId === source.active?.occurrenceId)).length;
  if (countTerminalOccurrences(owner) + additionalTombstones > SESSION_RUNTIME_ACTIVITY_TERMINAL_OCCURRENCE_LIMIT) return 'bounds';
  return {
    ...owner,
    state: 'idle',
    ownerSequence: mutation.ownerSequence,
    sources: owner.sources.map((source) => source.active
      ? addTerminalOccurrence({ ...source, active: null }, {
          occurrenceId: source.active.occurrenceId,
          terminalState: 'interrupted',
          lastOwnerSequence: mutation.ownerSequence,
        })
      : source),
  };
}

export function createSessionRuntimeActivityReducerStateV2(input: Readonly<{
  sessionId: string;
  writerGeneration: string;
  expectedOwnerScopes: readonly string[];
  revision: number;
}>): SessionRuntimeActivityReducerStateV2 {
  SessionRuntimeActivityExpectedOwnerManifestV2Schema.parse(input.expectedOwnerScopes);
  SessionRuntimeActivityWriterGenerationSchema.parse(input.writerGeneration);
  if (input.sessionId.trim().length === 0 || input.sessionId.length > 160) throw new Error('Invalid session id');
  SessionRuntimeActivityRevisionSchema.parse(input.revision);
  return {
    v: 2,
    sessionId: input.sessionId,
    writerGeneration: input.writerGeneration,
    owners: input.expectedOwnerScopes.map((ownerScope) => ({
      ownerScope,
      state: 'unknown',
      ownerSequence: 0,
      lowWatermark: 0,
      sources: [],
    })),
    receipts: [],
    projection: {
      v: 2,
      state: input.expectedOwnerScopes.length === 0 ? 'idle' : 'unknown',
      activeCount: 0,
      sourceClass: null,
      observedAtMs: null,
      revision: input.revision,
    },
  };
}

export function deriveSessionRuntimeActivityProjectionV2(
  state: SessionRuntimeActivityReducerStateV2,
): SessionRuntimeActivityProjectionV2 {
  return state.projection;
}

export function applySessionRuntimeActivityMutationV2(
  state: SessionRuntimeActivityReducerStateV2,
  mutation: SessionRuntimeActivityMutationV2,
  options: ApplySessionRuntimeActivityMutationV2Options,
): ApplySessionRuntimeActivityMutationV2Result {
  const requestDigest = SessionRuntimeActivityRequestDigestSchema.parse(options.requestDigest);
  const receipt = state.receipts.find((candidate) => candidate.mutationId === mutation.mutationId);
  if (receipt) {
    if (receipt.requestDigest === requestDigest) return { state, ack: receipt.ack };
    return {
      state,
      ack: buildAck(mutation, 'mutation-id-conflict', receipt.ownerSequence, state.projection),
    };
  }
  if (mutation.sessionId !== state.sessionId || mutation.writerGeneration !== state.writerGeneration) {
    return { state, ack: buildAck(mutation, 'stale-generation', 0, state.projection) };
  }
  const owner = state.owners.find((candidate) => candidate.ownerScope === mutation.ownerScope);
  if (!owner) return { state, ack: buildAck(mutation, 'owner-not-expected', 0, state.projection) };
  if (mutation.ownerSequence <= owner.ownerSequence || mutation.ownerSequence <= owner.lowWatermark) {
    return { state, ack: buildAck(mutation, 'stale-sequence', owner.ownerSequence, state.projection) };
  }
  if (mutation.ownerSequence !== owner.ownerSequence + 1) {
    return { state, ack: buildAck(mutation, 'sequence-gap', owner.ownerSequence, state.projection) };
  }
  if (state.receipts.length >= SESSION_RUNTIME_ACTIVITY_RECEIPT_LIMIT) {
    if (owner.state !== 'unknown' && state.receipts.length < SESSION_RUNTIME_ACTIVITY_RECEIPT_RETENTION_LIMIT) {
      return consumeUnknown(state, owner, mutation, { ...options, requestDigest }, 'bounds-exceeded');
    }
    return {
      state,
      ack: buildAck(mutation, 'bounds-exceeded', owner.ownerSequence, state.projection),
    };
  }

  let applied: OwnerState | 'resurrection' | 'bounds';
  switch (mutation.operation.type) {
    case 'source-upsert':
      applied = applySourceUpsert(owner, mutation);
      break;
    case 'source-terminal':
      applied = applySourceTerminal(owner, mutation);
      break;
    case 'owner-reconcile':
      applied = applyOwnerReconcile(owner, mutation);
      break;
    case 'owner-unknown':
      applied = markOwnerUnknown(owner, mutation.ownerSequence);
      break;
    case 'owner-terminal':
      applied = applyOwnerTerminal(owner, mutation);
      break;
    case 'owner-not-applicable':
      applied = applyOwnerTerminal(owner, mutation);
      break;
  }
  if (applied === 'resurrection') return consumeUnknown(state, owner, mutation, { ...options, requestDigest }, 'reconciliation-required');
  if (applied === 'bounds') return consumeUnknown(state, owner, mutation, { ...options, requestDigest }, 'bounds-exceeded');

  let next = replaceOwner(state, applied);
  next = refreshProjection(next, options.observedAtMs);
  const ack = buildAck(mutation, 'applied', mutation.ownerSequence, next.projection);
  next = withReceipt(next, mutation, requestDigest, ack);
  return { state: next, ack };
}

export function compactSessionRuntimeActivityReducerStateV2(
  state: SessionRuntimeActivityReducerStateV2,
  input: Readonly<{ ownerScope: string; throughSequence: number }>,
): SessionRuntimeActivityReducerStateV2 {
  const owner = state.owners.find((candidate) => candidate.ownerScope === input.ownerScope);
  if (!owner || !Number.isSafeInteger(input.throughSequence) || input.throughSequence < owner.lowWatermark) return state;
  if (input.throughSequence > owner.ownerSequence) return state;
  const compactedOwner = { ...owner, lowWatermark: input.throughSequence };
  return {
    ...replaceOwner(state, compactedOwner),
    receipts: state.receipts.filter((receipt) => (
      receipt.ownerScope !== input.ownerScope || receipt.ownerSequence > input.throughSequence
    )),
  };
}
