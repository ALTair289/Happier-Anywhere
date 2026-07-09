import {
  bumpWorkflowRunRecordRevision,
  isWorkflowRunSnapshotMaterialChange,
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowAgentSnapshotV1,
  type SessionWorkflowAgentStatusV1,
  type SessionWorkflowPhaseSnapshotV1,
  type SessionWorkflowRunSnapshotV1,
  type SessionWorkflowRunStatusReasonV1,
  type SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

import {
  parseClaudeWorkflowFact,
  type SubagentStartFact,
  type TaskLifecycleFact,
  type WorkflowJournalFact,
  type WorkflowJournalAgentSpecFact,
  type WorkflowLaunchFact,
  type WorkflowProgressAgentFact,
  type WorkflowStartFact,
} from './claudeWorkflowCorrelation';
import {
  CLAUDE_IMPLICIT_WORKFLOW_AGENT_THRESHOLD,
  CLAUDE_IMPLICIT_WORKFLOW_RUN_ID,
  CLAUDE_IMPLICIT_WORKFLOW_RUN_TITLE,
  type WorkflowActivityObservation,
} from './claudeWorkflowActivityTypes';

/**
 * CWF2 in-memory workflow activity tracker.
 *
 * Folds raw Claude transcript values into a PER-RUN `Map<runId>` and projects each changed run into
 * a provider-agnostic `SessionWorkflowRunSnapshotV1`. This is the single owner of run/phase/agent
 * correlation, status mapping (delegated to the protocol Claude status mapper via the fact parser),
 * and per-run `recordRevision` bumping. It uses mutable maps internally for O(new events) updates
 * but exposes only immutable per-run snapshots and a per-run change observation.
 *
 * Invariants enforced here (never in UI):
 * - Two concurrent `Workflow` runs never merge phases/agents — agent rows are namespaced by run.
 * - Explicit `Workflow` runs win over the implicit "Agent activity" run: a child proven to belong to
 *   an explicit run is migrated off the implicit run.
 * - `phases[]` are authoritative for phase title/order; an agent's `phaseTitle` is supplementary.
 * - A single plain subagent stays a task (no implicit promotion); >=2 correlated subagents promote.
 * - `recordRevision` advances only on a material normalized-snapshot change.
 */

type MutablePhase = {
  id: string;
  index: number;
  title?: string;
  agentIds: string[];
};

type MutableAgent = {
  id: string;
  title: string;
  status: SessionWorkflowAgentStatusV1;
  vendorRef?: string;
  parentId?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  summary?: string;
  resultPreview?: string;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
  updatedAt: number;
};

type MutableRun = {
  runId: string;
  workflowToolUseId?: string;
  providerTaskId?: string;
  explicit: boolean;
  status: SessionWorkflowRunStatusV1;
  statusReason?: SessionWorkflowRunStatusReasonV1;
  title: string;
  sourceSessionId?: string;
  /**
   * Count overrides used ONLY by startup reconciliation (W-1): a run seeded from a persisted
   * headline has no live agent rows, so its counts are carried here to keep the interrupted card
   * faithful (e.g. "3/17"). Ignored once real agent rows exist.
   */
  reconciledCounts?: Readonly<{
    totalAgents: number;
    completedAgents: number;
    failedAgents?: number;
    blockedAgents?: number;
  }>;
  startedAt?: number;
  completedAt?: number;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  phasesByIndex: Map<number, MutablePhase>;
  agentsById: Map<string, MutableAgent>;
  /** Arrival order of agent ids, so snapshot agent order is stable/deterministic. */
  agentOrder: string[];
  journalAgentSpecs: WorkflowJournalAgentSpecFact[];
  journalSpecIndexByKey: Map<string, number>;
  journalSpecIndexByAgentId: Map<string, number>;
  nextJournalSpecIndex: number;
  childToolUseIds: Set<string>;
  recordRevision: string;
  updatedAt: number;
};

export type ClaudeWorkflowActivityTracker = Readonly<{
  /** Fold one raw transcript value; returns the per-run change observation for the publisher. */
  observe(value: unknown, params: Readonly<{ updatedAt: number }>): WorkflowActivityObservation;
  /** Current projected snapshot for one run, or null if unknown. */
  getRunSnapshot(runId: string): SessionWorkflowRunSnapshotV1 | null;
  /** All current run snapshots keyed by runId. */
  getRunSnapshotMap(): ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  /** Run ids whose latest published agents are workflow-owned (CWF4 suppression hook). */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** Preferred provider-source key for runtime activity; falls back to the run id until learned. */
  getRuntimeActivitySourceKeyForRunId(runId: string): string | null;
  /**
   * Startup reconciliation (W-1): synthesize a terminal `stopped`/`interrupted` transition for a
   * run that was left active by a prior crashed process and has NOT been re-observed live. If the
   * run id is already known (genuinely resumed), this is a no-op and returns an empty observation.
   */
  reconcileInterruptedRunFromHeadline(
    run: WorkflowInterruptedRunSeed,
    params: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation;
}>;

/** Minimal detail needed to rebuild a faithful terminal snapshot for an interrupted run (W-1). */
export type WorkflowInterruptedRunSeed = Readonly<{
  runId: string;
  title: string;
  workflowToolUseId?: string;
  totalAgents: number;
  completedAgents: number;
  failedAgents?: number;
  blockedAgents?: number;
}>;

const TERMINAL_RUN_STATUSES: ReadonlySet<SessionWorkflowRunStatusV1> = new Set([
  'complete',
  'failed',
  'stopped',
  'cancelled',
]);

function isTerminalRunStatus(status: SessionWorkflowRunStatusV1): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

const TERMINAL_AGENT_STATUSES: ReadonlySet<SessionWorkflowAgentStatusV1> = new Set([
  'complete',
  'failed',
  'cancelled',
]);

function isTerminalAgentStatus(status: SessionWorkflowAgentStatusV1): boolean {
  return TERMINAL_AGENT_STATUSES.has(status);
}

/** Map an agent status signal up to a whole-run status when a lifecycle/terminal event lands. */
function runStatusFromSignal(signal: SessionWorkflowAgentStatusV1): SessionWorkflowRunStatusV1 {
  switch (signal) {
    case 'complete':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'pending':
    case 'active':
      return 'active';
    default:
      return 'unknown';
  }
}

export function createClaudeWorkflowActivityTracker(params: Readonly<{
  backendId: string;
  agentId?: string;
  /**
   * Optional foreign-session guard. When provided and non-null, events whose source Claude session id
   * differs are rejected (mirrors the goal source's cross-session guard). Null/absent => accept all.
   */
  getCurrentClaudeSessionId?: () => string | null;
}>): ClaudeWorkflowActivityTracker {
  const runs = new Map<string, MutableRun>();
  const runIdByChildToolUseId = new Map<string, string>();
  // Claude `task_updated` terminal events carry only `task_id` (no `tool_use_id`), so the run's
  // provider task id is learned from earlier lifecycle events that carry both and used to route.
  const runIdByTaskId = new Map<string, string>();
  let implicitRunId: string | undefined;

  // Cache the last projected snapshot per run so revision bumps + change detection are stable.
  const lastSnapshotByRun = new Map<string, SessionWorkflowRunSnapshotV1>();

  function resolveGuardSessionId(): string | null {
    return params.getCurrentClaudeSessionId?.() ?? null;
  }

  function isForeignSource(sourceSessionId: string | undefined): boolean {
    const guard = resolveGuardSessionId();
    if (!guard) return false;
    if (!sourceSessionId) return false;
    return sourceSessionId !== guard;
  }

  function ensureRun(runId: string, init: Partial<MutableRun> & { title: string; explicit: boolean }): MutableRun {
    const existing = runs.get(runId);
    if (existing) {
      if (init.explicit && !existing.explicit) existing.explicit = true;
      return existing;
    }
    const run: MutableRun = {
      runId,
      explicit: init.explicit,
      status: init.status ?? 'active',
      title: init.title,
      phasesByIndex: new Map(),
      agentsById: new Map(),
      agentOrder: [],
      journalAgentSpecs: [],
      journalSpecIndexByKey: new Map(),
      journalSpecIndexByAgentId: new Map(),
      nextJournalSpecIndex: 0,
      childToolUseIds: new Set(),
      recordRevision: '0',
      updatedAt: init.updatedAt ?? 0,
      ...(init.workflowToolUseId ? { workflowToolUseId: init.workflowToolUseId } : {}),
      ...(init.sourceSessionId ? { sourceSessionId: init.sourceSessionId } : {}),
      ...(init.startedAt !== undefined ? { startedAt: init.startedAt } : {}),
    };
    runs.set(runId, run);
    return run;
  }

  function upsertPhase(run: MutableRun, index: number, title: string | undefined): void {
    const existing = run.phasesByIndex.get(index);
    if (existing) {
      // `phases[]` are authoritative: a present phase title is preserved; only fill when missing.
      if (title && !existing.title) existing.title = title;
      return;
    }
    run.phasesByIndex.set(index, {
      id: `phase:${index}`,
      index,
      ...(title ? { title } : {}),
      agentIds: [],
    });
  }

  function assignAgentToPhase(run: MutableRun, agentId: string, phaseIndex: number | undefined): void {
    if (phaseIndex === undefined) return;
    let phase = run.phasesByIndex.get(phaseIndex);
    if (!phase) {
      upsertPhase(run, phaseIndex, undefined);
      phase = run.phasesByIndex.get(phaseIndex);
    }
    if (phase && !phase.agentIds.includes(agentId)) {
      phase.agentIds.push(agentId);
    }
  }

  function upsertAgent(run: MutableRun, agent: Readonly<{
    id: string;
    title: string;
    status: SessionWorkflowAgentStatusV1;
    vendorRef?: string;
    parentId?: string;
    phaseIndex?: number;
    phaseTitle?: string;
    model?: string;
    summary?: string;
    resultPreview?: string;
    tokensUsed?: number;
    toolCalls?: number;
    timeUsedSeconds?: number;
    startedAt?: number;
    completedAt?: number;
    attempt?: number;
    updatedAt: number;
  }>): void {
    const existing = run.agentsById.get(agent.id);
    if (!existing) {
      const created: MutableAgent = {
        id: agent.id,
        title: agent.title,
        status: agent.status,
        updatedAt: agent.updatedAt,
        ...(agent.vendorRef ? { vendorRef: agent.vendorRef } : {}),
        ...(agent.parentId ? { parentId: agent.parentId } : {}),
        ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
        ...(agent.phaseTitle ? { phaseTitle: agent.phaseTitle } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
        ...(agent.tokensUsed !== undefined ? { tokensUsed: agent.tokensUsed } : {}),
        ...(agent.toolCalls !== undefined ? { toolCalls: agent.toolCalls } : {}),
        ...(agent.timeUsedSeconds !== undefined ? { timeUsedSeconds: agent.timeUsedSeconds } : {}),
        ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
        ...(agent.completedAt !== undefined ? { completedAt: agent.completedAt } : {}),
        ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
      };
      run.agentsById.set(agent.id, created);
      run.agentOrder.push(agent.id);
      assignAgentToPhase(run, agent.id, agent.phaseIndex);
      return;
    }
    // Latest-wins merge: newer non-empty fields overwrite; ids/order preserved.
    const isNewerAttempt = agent.attempt !== undefined && (existing.attempt === undefined || agent.attempt > existing.attempt);
    const shouldPreserveTerminalStatus = isTerminalAgentStatus(existing.status)
      && !isTerminalAgentStatus(agent.status)
      && !isNewerAttempt;
    existing.title = agent.title || existing.title;
    if (!shouldPreserveTerminalStatus) {
      existing.status = agent.status;
      existing.updatedAt = agent.updatedAt;
      if (isNewerAttempt && !isTerminalAgentStatus(agent.status)) {
        delete existing.resultPreview;
        delete existing.summary;
        delete existing.completedAt;
      }
    }
    if (agent.vendorRef) existing.vendorRef = agent.vendorRef;
    if (agent.parentId) existing.parentId = agent.parentId;
    if (agent.phaseIndex !== undefined) existing.phaseIndex = agent.phaseIndex;
    if (agent.phaseTitle) existing.phaseTitle = agent.phaseTitle;
    if (agent.model) existing.model = agent.model;
    if (agent.summary) existing.summary = agent.summary;
    if (agent.resultPreview) existing.resultPreview = agent.resultPreview;
    if (agent.tokensUsed !== undefined) existing.tokensUsed = agent.tokensUsed;
    if (agent.toolCalls !== undefined) existing.toolCalls = agent.toolCalls;
    if (agent.timeUsedSeconds !== undefined) existing.timeUsedSeconds = agent.timeUsedSeconds;
    if (agent.startedAt !== undefined) existing.startedAt = agent.startedAt;
    if (agent.completedAt !== undefined) existing.completedAt = agent.completedAt;
    if (agent.attempt !== undefined) existing.attempt = agent.attempt;
    assignAgentToPhase(run, agent.id, agent.phaseIndex);
  }

  /** Migrate an agent and its child tool-use routing off the implicit run onto an explicit run. */
  function migrateImplicitAgentToExplicit(agentId: string, explicitRun: MutableRun): void {
    if (!implicitRunId) return;
    const implicit = runs.get(implicitRunId);
    if (!implicit || implicit.runId === explicitRun.runId) return;
    if (!implicit.agentsById.has(agentId)) return;
    implicit.agentsById.delete(agentId);
    implicit.agentOrder = implicit.agentOrder.filter((id) => id !== agentId);
    for (const phase of implicit.phasesByIndex.values()) {
      phase.agentIds = phase.agentIds.filter((id) => id !== agentId);
    }
    implicit.childToolUseIds.delete(agentId);
    runIdByChildToolUseId.set(agentId, explicitRun.runId);
    // Drop the implicit run entirely once it no longer has enough agents to justify a card.
    if (implicit.agentsById.size === 0) {
      runs.delete(implicit.runId);
      lastSnapshotByRun.delete(implicit.runId);
      implicitRunId = undefined;
    }
  }

  function applyWorkflowStart(fact: WorkflowStartFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const run = ensureRun(fact.workflowToolUseId, {
      title: fact.title,
      explicit: true,
      status: 'active',
      workflowToolUseId: fact.workflowToolUseId,
      ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      updatedAt,
      startedAt: updatedAt,
    });
    for (const phase of fact.phases ?? []) {
      upsertPhase(run, phase.index, phase.title);
    }
    if (fact.journalAgentSpecs?.length) {
      run.journalAgentSpecs = [...fact.journalAgentSpecs];
      run.journalSpecIndexByKey.clear();
      run.journalSpecIndexByAgentId.clear();
      run.nextJournalSpecIndex = 0;
    }
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applyWorkflowLaunch(fact: WorkflowLaunchFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const existing = runs.get(fact.workflowToolUseId);
    if (!existing && !fact.confirmedLocalWorkflow) return null;
    const run = ensureRun(fact.workflowToolUseId, {
      title: fact.title ?? 'Workflow',
      explicit: true,
      status: 'active',
      workflowToolUseId: fact.workflowToolUseId,
      ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      updatedAt,
      startedAt: updatedAt,
    });
    if (fact.title) run.title = fact.title;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    if (fact.taskId) {
      run.providerTaskId = fact.taskId;
      runIdByTaskId.set(fact.taskId, run.runId);
    }
    if (!isTerminalRunStatus(run.status)) run.status = 'active';
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applyTaskLifecycle(fact: TaskLifecycleFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const toolUseId = fact.toolUseId;
    // Route to an explicit Workflow run if the tool-use id names one, else to a child's owning run,
    // else via the run's learned provider task id (terminal `task_updated` carries only `task_id`).
    let run: MutableRun | undefined;
    if (toolUseId) {
      run = runs.get(toolUseId);
      if (!run) {
        const childRunId = runIdByChildToolUseId.get(toolUseId);
        if (childRunId) run = runs.get(childRunId);
      }
    }
    if (!run && fact.taskId) {
      const taskRunId = runIdByTaskId.get(fact.taskId);
      if (taskRunId) run = runs.get(taskRunId);
    }
    if (!run) return null;

    // Learn the run's provider task id so a later id-only terminal event can route back to it.
    if (fact.taskId) {
      run.providerTaskId = fact.taskId;
      runIdByTaskId.set(fact.taskId, run.runId);
    }

    run.updatedAt = updatedAt;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    if (fact.usage.tokensUsed !== undefined) run.tokensUsed = fact.usage.tokensUsed;
    if (fact.usage.toolCalls !== undefined) run.toolCalls = fact.usage.toolCalls;
    if (fact.usage.timeUsedSeconds !== undefined) run.timeUsedSeconds = fact.usage.timeUsedSeconds;
    if (fact.startedAt !== undefined && run.startedAt === undefined) run.startedAt = fact.startedAt;
    if (fact.completedAt !== undefined) run.completedAt = fact.completedAt;

    // Workflow phase/agent rows are the canonical Dynamic Workflow structure.
    for (const entry of fact.workflowProgress ?? []) {
      if (entry.kind === 'phase') {
        upsertPhase(run, entry.index, entry.title);
        continue;
      }
      applyWorkflowProgressAgent(run, entry, updatedAt);
    }

    // Whole-run status: a terminal lifecycle event closes the run; otherwise it stays active.
    const runSignal = runStatusFromSignal(fact.status);
    if (isTerminalRunStatus(runSignal)) {
      run.status = runSignal;
      // A real terminal transition supersedes any synthetic "interrupted" reconciliation qualifier
      // (e.g. a late-arriving completion for a run that was reconciled after the grace window).
      delete run.statusReason;
    } else if (!isTerminalRunStatus(run.status)) {
      run.status = runSignal === 'unknown' ? run.status : runSignal;
    }
    return run.runId;
  }

  function applyWorkflowProgressAgent(run: MutableRun, entry: WorkflowProgressAgentFact, updatedAt: number): void {
    // Explicit-wins: if this agent currently lives on the implicit run, migrate it here.
    migrateImplicitAgentToExplicit(entry.id, run);
    upsertAgent(run, {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      updatedAt,
      ...(entry.vendorRef ? { vendorRef: entry.vendorRef } : {}),
      ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
      ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.resultPreview ? { resultPreview: entry.resultPreview } : {}),
      ...(entry.tokensUsed !== undefined ? { tokensUsed: entry.tokensUsed } : {}),
      ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.timeUsedSeconds !== undefined ? { timeUsedSeconds: entry.timeUsedSeconds } : {}),
      ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
    });
    run.childToolUseIds.add(entry.id);
    if (entry.vendorRef) run.childToolUseIds.add(entry.vendorRef);
    runIdByChildToolUseId.set(entry.id, run.runId);
    if (entry.vendorRef) runIdByChildToolUseId.set(entry.vendorRef, run.runId);
  }

  function resolveJournalPhaseIndex(run: MutableRun, fact: WorkflowJournalFact): number | undefined {
    if (fact.phaseTitle) {
      const normalized = fact.phaseTitle.toLocaleLowerCase();
      for (const phase of run.phasesByIndex.values()) {
        if (phase.title?.toLocaleLowerCase() === normalized) return phase.index;
      }
      const nextIndex = Math.max(0, ...[...run.phasesByIndex.keys()]) + 1;
      upsertPhase(run, nextIndex, fact.phaseTitle);
      return nextIndex;
    }
    if (run.phasesByIndex.size === 1) {
      return [...run.phasesByIndex.keys()][0];
    }
    return undefined;
  }

  function resolveJournalSpec(run: MutableRun, fact: WorkflowJournalFact): WorkflowJournalAgentSpecFact | undefined {
    if (fact.journalKey) {
      const existingIndex = run.journalSpecIndexByKey.get(fact.journalKey);
      if (existingIndex !== undefined) return run.journalAgentSpecs[existingIndex];
    }
    const existingAgentIndex = run.journalSpecIndexByAgentId.get(fact.agentId);
    if (existingAgentIndex !== undefined) {
      if (fact.journalKey) run.journalSpecIndexByKey.set(fact.journalKey, existingAgentIndex);
      return run.journalAgentSpecs[existingAgentIndex];
    }

    const assignedIndexes = new Set([...run.journalSpecIndexByKey.values(), ...run.journalSpecIndexByAgentId.values()]);
    const titleNormalized = fact.title.toLocaleLowerCase();
    const matchingIndex = run.journalAgentSpecs.findIndex((spec, index) => {
      if (assignedIndexes.has(index)) return false;
      return spec.label.toLocaleLowerCase() === titleNormalized;
    });
    const index = matchingIndex >= 0 ? matchingIndex : run.nextJournalSpecIndex;
    const spec = run.journalAgentSpecs[index];
    if (!spec) return undefined;
    if (matchingIndex < 0) run.nextJournalSpecIndex = index + 1;
    if (fact.journalKey) run.journalSpecIndexByKey.set(fact.journalKey, index);
    run.journalSpecIndexByAgentId.set(fact.agentId, index);
    return spec;
  }

  function applyWorkflowJournal(fact: WorkflowJournalFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const run = runs.get(fact.workflowToolUseId);
    if (!run) return null;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    const journalSpec = resolveJournalSpec(run, fact);
    const existingAgentIndex = run.agentOrder.indexOf(fact.agentId);
    const fallbackOrdinal = existingAgentIndex >= 0 ? existingAgentIndex + 1 : run.agentOrder.length + 1;
    // W-7: a journal fact whose title is just the raw agent id is opaque — regardless of status. A
    // terminal `result` entry with no lane/label/message fields falls back to the agentId in the
    // parser, so gating this on `status === 'active'` (the old code) leaked the RAW HEX AGENT ID as
    // the row title for completed agents. Never display a raw agent id.
    const isOpaqueJournalTitle = fact.title === fact.agentId;
    // Prefer, in order: explicit label from the workflow script spec -> `Workflow agent N` ordinal.
    // (A prompt first-line excerpt would slot between these, but journal facts do not currently
    // carry the prompt — see claudeWorkflowCorrelation.parseWorkflowJournalFact; recorded as the
    // upstream loss point in the lane report.) The ordinal is a stable last resort.
    const journalLabel = journalSpec && journalSpec.label !== fact.agentId ? journalSpec.label : undefined;
    const resolvedTitle = isOpaqueJournalTitle
      ? (journalLabel ?? `Workflow agent ${fallbackOrdinal}`)
      : fact.title;
    const effectiveFact = journalSpec
      ? {
        ...fact,
        title: resolvedTitle,
        phaseTitle: fact.phaseTitle ?? journalSpec.phaseTitle,
      }
      : {
        ...fact,
        title: resolvedTitle,
      };
    const phaseIndex = resolveJournalPhaseIndex(run, effectiveFact);
    upsertAgent(run, {
      id: effectiveFact.agentId,
      title: effectiveFact.title,
      status: effectiveFact.status,
      updatedAt,
      parentId: effectiveFact.workflowToolUseId,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(effectiveFact.phaseTitle ? { phaseTitle: effectiveFact.phaseTitle } : {}),
      ...(effectiveFact.summary ? { summary: effectiveFact.summary } : {}),
      ...(effectiveFact.resultPreview ? { resultPreview: effectiveFact.resultPreview } : {}),
    });
    run.childToolUseIds.add(effectiveFact.agentId);
    runIdByChildToolUseId.set(effectiveFact.agentId, run.runId);
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applySubagentStart(fact: SubagentStartFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    // A child whose explicit parent is a known Workflow run attaches there (explicit-wins).
    if (fact.parentToolUseId) {
      const parentRun = runs.get(fact.parentToolUseId);
      if (parentRun) {
        migrateImplicitAgentToExplicit(fact.toolUseId, parentRun);
        upsertAgent(parentRun, {
          id: fact.toolUseId,
          title: fact.title,
          status: 'active',
          updatedAt,
          parentId: fact.parentToolUseId,
        });
        parentRun.childToolUseIds.add(fact.toolUseId);
        runIdByChildToolUseId.set(fact.toolUseId, parentRun.runId);
        parentRun.updatedAt = updatedAt;
        return parentRun.runId;
      }
    }

    // Otherwise this is implicit-run material. Buffer it; promote to a run only at the threshold.
    return promoteImplicitSubagent(fact, updatedAt);
  }

  // Plain subagents that are not (yet) owned by an explicit run. They become an implicit run only
  // once >= threshold are seen, so a single plain subagent stays a task (CWF4).
  const pendingImplicitSubagents = new Map<string, SubagentStartFact & { updatedAt: number }>();

  function promoteImplicitSubagent(fact: SubagentStartFact, updatedAt: number): string | null {
    if (implicitRunId) {
      const run = runs.get(implicitRunId);
      if (run) {
        upsertAgent(run, { id: fact.toolUseId, title: fact.title, status: 'active', updatedAt });
        run.childToolUseIds.add(fact.toolUseId);
        runIdByChildToolUseId.set(fact.toolUseId, run.runId);
        run.updatedAt = updatedAt;
        return run.runId;
      }
    }

    pendingImplicitSubagents.set(fact.toolUseId, { ...fact, updatedAt });
    if (pendingImplicitSubagents.size < CLAUDE_IMPLICIT_WORKFLOW_AGENT_THRESHOLD) {
      return null;
    }
    // Threshold reached: synthesize the implicit run from all buffered subagents.
    implicitRunId = CLAUDE_IMPLICIT_WORKFLOW_RUN_ID;
    const run = ensureRun(implicitRunId, {
      title: CLAUDE_IMPLICIT_WORKFLOW_RUN_TITLE,
      explicit: false,
      status: 'active',
      updatedAt,
      startedAt: updatedAt,
    });
    for (const pending of pendingImplicitSubagents.values()) {
      upsertAgent(run, { id: pending.toolUseId, title: pending.title, status: 'active', updatedAt: pending.updatedAt });
      run.childToolUseIds.add(pending.toolUseId);
      runIdByChildToolUseId.set(pending.toolUseId, run.runId);
    }
    pendingImplicitSubagents.clear();
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function projectPhases(run: MutableRun): SessionWorkflowPhaseSnapshotV1[] {
    return [...run.phasesByIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((phase) => ({
        id: phase.id,
        order: phase.index,
        agentIds: [...phase.agentIds],
        ...(phase.title ? { title: phase.title } : {}),
      }));
  }

  function projectAgents(run: MutableRun): SessionWorkflowAgentSnapshotV1[] {
    return run.agentOrder
      .map((id) => run.agentsById.get(id))
      .filter((agent): agent is MutableAgent => agent !== undefined)
      .map((agent) => ({
        id: agent.id,
        title: agent.title,
        status: agent.status,
        updatedAt: agent.updatedAt,
        ...(agent.vendorRef ? { vendorRef: agent.vendorRef } : {}),
        ...(agent.parentId ? { parentId: agent.parentId } : {}),
        ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
        ...(agent.phaseTitle ? { phaseTitle: agent.phaseTitle } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
        ...(agent.tokensUsed !== undefined ? { tokensUsed: agent.tokensUsed } : {}),
        ...(agent.toolCalls !== undefined ? { toolCalls: agent.toolCalls } : {}),
        ...(agent.timeUsedSeconds !== undefined ? { timeUsedSeconds: agent.timeUsedSeconds } : {}),
        ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
        ...(agent.completedAt !== undefined ? { completedAt: agent.completedAt } : {}),
      }));
  }

  function countAgents(agents: readonly SessionWorkflowAgentSnapshotV1[], status: SessionWorkflowAgentStatusV1): number {
    return agents.reduce((acc, agent) => (agent.status === status ? acc + 1 : acc), 0);
  }

  /**
   * Project the mutable run into the durable snapshot and bump `recordRevision` only on a material
   * change vs the last projection. Returns the snapshot plus whether it changed materially.
   */
  function projectRun(run: MutableRun): { snapshot: SessionWorkflowRunSnapshotV1; material: boolean } {
    const phases = projectPhases(run);
    const agents = projectAgents(run);
    const previous = lastSnapshotByRun.get(run.runId);

    // Reconciled-from-headline runs (W-1 startup reconcile) have no live agent rows; fall back to
    // the counts carried from the persisted headline so the interrupted card stays faithful.
    const reconciled = agents.length === 0 ? run.reconciledCounts : undefined;
    const totalAgents = reconciled ? reconciled.totalAgents : agents.length;
    const completedAgents = reconciled ? reconciled.completedAgents : countAgents(agents, 'complete');
    const failedAgents = reconciled ? (reconciled.failedAgents ?? 0) : countAgents(agents, 'failed');
    const blockedAgents = reconciled ? (reconciled.blockedAgents ?? 0) : countAgents(agents, 'blocked');
    const cancelledAgents = countAgents(agents, 'cancelled');

    const base: SessionWorkflowRunSnapshotV1 = {
      v: 1,
      projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
      runId: run.runId,
      backendId: params.backendId,
      title: run.title,
      status: run.status,
      // Carry the previous revision; the material check below recomputes it.
      recordRevision: previous?.recordRevision ?? '0',
      updatedAt: run.updatedAt,
      totalAgents,
      completedAgents,
      phases,
      agents,
      ...(run.statusReason ? { statusReason: run.statusReason } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(run.workflowToolUseId ? { workflowToolUseId: run.workflowToolUseId } : {}),
      ...(run.sourceSessionId ? { sourceSessionId: run.sourceSessionId } : {}),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(failedAgents > 0 ? { failedAgents } : {}),
      ...(blockedAgents > 0 ? { blockedAgents } : {}),
      ...(cancelledAgents > 0 ? { cancelledAgents } : {}),
      ...(run.tokensUsed !== undefined ? { tokensUsed: run.tokensUsed } : {}),
      ...(run.toolCalls !== undefined ? { toolCalls: run.toolCalls } : {}),
      ...(run.timeUsedSeconds !== undefined ? { timeUsedSeconds: run.timeUsedSeconds } : {}),
    };

    const material = isWorkflowRunSnapshotMaterialChange(previous, base);
    const recordRevision = bumpWorkflowRunRecordRevision(previous?.recordRevision, material);
    const snapshot: SessionWorkflowRunSnapshotV1 = { ...base, recordRevision };
    run.recordRevision = recordRevision;
    if (material) {
      lastSnapshotByRun.set(run.runId, snapshot);
    }
    return { snapshot, material };
  }

  function observe(value: unknown, observeParams: Readonly<{ updatedAt: number }>): WorkflowActivityObservation {
    const fact = parseClaudeWorkflowFact(value);
    if (!fact) {
      return { changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] };
    }

    const priorRunIds = new Set(runs.keys());
    const priorStatusByRun = new Map<string, SessionWorkflowRunStatusV1>();
    for (const [runId, run] of runs) priorStatusByRun.set(runId, run.status);

    let touchedRunId: string | null = null;
    if (fact.kind === 'workflow-start') {
      touchedRunId = applyWorkflowStart(fact, observeParams.updatedAt);
    } else if (fact.kind === 'workflow-launch') {
      touchedRunId = applyWorkflowLaunch(fact, observeParams.updatedAt);
    } else if (fact.kind === 'task-lifecycle') {
      touchedRunId = applyTaskLifecycle(fact, observeParams.updatedAt);
    } else if (fact.kind === 'workflow-journal') {
      touchedRunId = applyWorkflowJournal(fact, observeParams.updatedAt);
    } else {
      touchedRunId = applySubagentStart(fact, observeParams.updatedAt);
    }

    if (!touchedRunId) {
      return { changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] };
    }

    // Migration may have dropped the implicit run; recompute change set across all current runs that
    // were touched this event (the touched run plus a possibly-pruned implicit run).
    const changedRunIds: string[] = [];
    const startedRunIds: string[] = [];
    const terminalRunIds: string[] = [];
    const statusChangedRunIds: string[] = [];

    const candidateRunIds = new Set<string>([touchedRunId]);
    // The implicit run may have lost an agent this event; re-project it too so counts stay correct.
    if (implicitRunId && runs.has(implicitRunId)) candidateRunIds.add(implicitRunId);

    for (const runId of candidateRunIds) {
      const run = runs.get(runId);
      if (!run) continue;
      const { material } = projectRun(run);
      const isNewRun = !priorRunIds.has(runId);
      if (material || isNewRun) changedRunIds.push(runId);
      if (isNewRun) startedRunIds.push(runId);
      const priorStatus = priorStatusByRun.get(runId);
      if (priorStatus !== undefined && priorStatus !== run.status) statusChangedRunIds.push(runId);
      if (isTerminalRunStatus(run.status) && (isNewRun || priorStatus !== run.status)) {
        terminalRunIds.push(runId);
      }
    }

    return { changedRunIds, startedRunIds, terminalRunIds, statusChangedRunIds };
  }

  function getRunSnapshot(runId: string): SessionWorkflowRunSnapshotV1 | null {
    const run = runs.get(runId);
    if (!run) return null;
    return lastSnapshotByRun.get(runId) ?? projectRun(run).snapshot;
  }

  function getRunSnapshotMap(): ReadonlyMap<string, SessionWorkflowRunSnapshotV1> {
    const map = new Map<string, SessionWorkflowRunSnapshotV1>();
    for (const runId of runs.keys()) {
      const snapshot = getRunSnapshot(runId);
      if (snapshot) map.set(runId, snapshot);
    }
    return map;
  }

  function getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string> {
    const owned = new Set<string>();
    for (const run of runs.values()) {
      for (const childId of run.childToolUseIds) owned.add(childId);
    }
    return owned;
  }

  function getRuntimeActivitySourceKeyForRunId(runId: string): string | null {
    const run = runs.get(runId);
    if (!run) return null;
    return run.providerTaskId ?? run.workflowToolUseId ?? run.runId;
  }

  function reconcileInterruptedRunFromHeadline(
    seed: WorkflowInterruptedRunSeed,
    reconcileParams: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation {
    const empty: WorkflowActivityObservation = {
      changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [],
    };
    // Already known => the run was genuinely re-observed live since startup; never override it.
    if (runs.has(seed.runId)) return empty;

    const run = ensureRun(seed.runId, {
      title: seed.title,
      explicit: true,
      status: 'stopped',
      updatedAt: reconcileParams.updatedAt,
      startedAt: reconcileParams.updatedAt,
      ...(seed.workflowToolUseId ? { workflowToolUseId: seed.workflowToolUseId } : {}),
    });
    run.status = 'stopped';
    run.statusReason = 'interrupted';
    run.completedAt = reconcileParams.updatedAt;
    run.updatedAt = reconcileParams.updatedAt;
    run.reconciledCounts = {
      totalAgents: seed.totalAgents,
      completedAgents: seed.completedAgents,
      ...(seed.failedAgents !== undefined ? { failedAgents: seed.failedAgents } : {}),
      ...(seed.blockedAgents !== undefined ? { blockedAgents: seed.blockedAgents } : {}),
    };
    projectRun(run);
    // Emit as a terminal transition only (no `startedRunIds`): we never want a runtime-activity
    // "working" blip for a run we are immediately terminating.
    return {
      changedRunIds: [run.runId],
      startedRunIds: [],
      terminalRunIds: [run.runId],
      statusChangedRunIds: [run.runId],
    };
  }

  return {
    observe,
    getRunSnapshot,
    getRunSnapshotMap,
    getWorkflowOwnedAgentToolUseIds,
    getRuntimeActivitySourceKeyForRunId,
    reconcileInterruptedRunFromHeadline,
  };
}
