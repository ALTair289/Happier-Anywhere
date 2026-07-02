import { isClaudeSlashCommandSupported, type SessionWorkStateV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import { routeClaudeAttachment } from '../attachments/claudeAttachmentRouter';
import { buildEmptyClaudeGoalWorkStateSnapshot, createClaudeGoalStatusWorkStateTracker } from './claudeGoalStatus';

/**
 * Centralized Claude native `/goal` SOURCE wiring (plan H6).
 *
 * The native Claude `/goal` feature surfaces goal state as a transcript
 * `attachment` record (`attachment.type === 'goal_status'`) and exposes the
 * `/goal` command through the system/init `slash_commands` list. Both signals
 * travel on the same transcript stream that every Claude launcher observes.
 *
 * This module is the ONE place that knows how to turn those transcript signals
 * into a published `SessionWorkStateItemV1 kind:'goal'`. It wraps the latest-wins
 * goal tracker, the attachment router, and the fail-closed `/goal` capability
 * gate so that EVERY launcher path (remote daemon, local, unified-terminal
 * standalone) wires the goal source identically by observing transcript messages
 * — instead of each launcher re-implementing the routing inline (which left the
 * source DEAD on the local + unified-standalone paths; QA-found).
 *
 * Allocation-light: safe to call for every transcript row inside the tail-follow
 * loop. The publish callback is invoked only when the resolved goal item changes.
 */

export type ClaudeGoalWorkStateSource = Readonly<{
  /**
   * Observe one transcript message (raw JSONL row or SDK message). Routes a
   * `goal_status` attachment into the goal work-state and reads the `/goal`
   * capability from a system/init record's `slash_commands`. Non-goal messages
   * and unknown attachment subtypes are ignored.
   */
  observeTranscriptMessage(message: unknown): void;
  /**
   * Apply the `/goal` capability directly from a `slash_commands` list (the
   * remote agent-SDK runner surfaces these via an `onCapabilities` callback in
   * addition to the system/init transcript record). Fail-closed: unknown/missing
   * commands leave the capability disabled.
   */
  applySlashCommands(slashCommands: unknown): void;
  /**
   * Deterministically remove the published Claude goal work-state item (publishes an empty
   * goal-owned snapshot) AND record a goal-control CLEAR intent so the provider's continued ACTIVE
   * re-evaluation of the cleared goal does not resurrect it. Used by the ACTIVE-session clear
   * effector because Claude's `/goal clear` emits no `goal_status` attachment the source could
   * observe — without this the work-state keeps showing the last (now-stale) goal after a clear.
   * Idempotent.
   */
  clearGoalWorkState(): void;
  /**
   * Record a goal-control SET intent (the ACTIVE-session set effector injects `/goal <objective>`).
   * Bumps the goal-control epoch so re-setting the SAME objective after a clear is accepted — the
   * resulting active `goal_status` is no longer treated as a stale post-clear replay (G2/QA-CHIP-4).
   * Does not publish; the goal item still comes from the subsequent observed `goal_status`.
   */
  recordGoalSetIntent(): void;
}>;

function readSlashCommandsFromSystemMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as { type?: unknown; slash_commands?: unknown };
  if (record.type !== 'system') return undefined;
  return record.slash_commands;
}

/**
 * Read the Claude transcript session id that ESTABLISHES the channel's identity, from a record.
 * Every record on a Claude session's transcript channel (system, assistant, user, …) carries the
 * Claude session id under `sessionId` (camelCase) — this is the id `goal_status` attachments are
 * matched against, NOT the Happier session id.
 *
 * `goal_status` attachments are intentionally excluded: an attachment must be VALIDATED against the
 * established channel id, so it cannot be allowed to self-authorize (which would defeat the
 * cross-session guard). Non-goal_status records define the session; the goal_status attachment is
 * the thing being guarded.
 */
function readEstablishingClaudeSessionIdFromMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as { sessionId?: unknown; attachment?: { type?: unknown } };
  if (record.attachment && typeof record.attachment === 'object'
    && (record.attachment as { type?: unknown }).type === 'goal_status') {
    return null;
  }
  const value = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  return value.length > 0 ? value : null;
}

export function createClaudeGoalWorkStateSource(params: Readonly<{
  backendId: string;
  agentId?: string;
  publishWorkStateSnapshot: (snapshot: SessionWorkStateV1) => void;
  /**
   * Optional seed for the active CLAUDE transcript session id used by the cross-session guard
   * (mirrors happy's `metadata.claudeSessionId`). This MUST be the Claude session id (the transcript
   * `sessionId`), NOT the Happier session id — the latter never matches a `goal_status` attachment's
   * `sessionId` and would drop every goal. The source also self-learns this id from the transcript
   * records it observes, so a `null` seed is fine (the guard is then a no-op until the channel's id
   * is established, exactly like happy when `claudeSessionId` is still unknown).
   */
  getCurrentClaudeSessionId: () => string | null;
  logPrefix?: string;
}>): ClaudeGoalWorkStateSource {
  const logPrefix = params.logPrefix ?? '[claude-goal-source]';
  const tracker = createClaudeGoalStatusWorkStateTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    // Fail-closed: `/goal` support is confirmed FACTUALLY from the runtime
    // `slash_commands` (see applySlashCommands), not assumed.
  });

  // The Claude session id this source guards against. Self-learned (latest-wins) from the channel's
  // establishing records; the injected seed is consulted only before any has been observed. Null =>
  // guard is a no-op (accept), matching happy's behavior when the claude session id is still unknown.
  let observedClaudeSessionId: string | null = null;
  const resolveCurrentClaudeSessionId = (): string | null =>
    observedClaudeSessionId ?? params.getCurrentClaudeSessionId();

  const publish = (snapshot: SessionWorkStateV1 | null): void => {
    if (!snapshot) return;
    try {
      params.publishWorkStateSnapshot(snapshot);
    } catch (error) {
      logger.debug(`${logPrefix}: failed to publish Claude goal work-state snapshot (non-fatal)`, error);
    }
  };

  const applySlashCommands = (slashCommands: unknown): void => {
    // A non-array carries no capability info: leave the current `/goal` support untouched rather
    // than flipping it off. The `goal`/`/goal` shape parity lives in the shared protocol helper.
    if (!Array.isArray(slashCommands)) return;
    publish(tracker.setGoalCommandSupported(isClaudeSlashCommandSupported(slashCommands, 'goal'), {
      updatedAt: Date.now(),
      currentClaudeSessionId: resolveCurrentClaudeSessionId(),
    }));
  };

  return {
    observeTranscriptMessage(message) {
      // Learn (and adopt, latest-wins) the Claude session id from this channel's ESTABLISHING
      // records (system/assistant/user — never the goal_status attachment itself) BEFORE the guard,
      // so the session's own `goal_status` attachments are never dropped while genuinely foreign
      // session ids (resume tail-bleed) are still rejected.
      const recordSessionId = readEstablishingClaudeSessionIdFromMessage(message);
      if (recordSessionId) observedClaudeSessionId = recordSessionId;

      routeClaudeAttachment(message, {
        onGoalStatus: (event) => {
          publish(tracker.applyAttachment(event, {
            updatedAt: Date.now(),
            currentClaudeSessionId: resolveCurrentClaudeSessionId(),
          }));
        },
      });
      // The system/init record carries the `slash_commands` list on the same
      // transcript stream; gate `/goal` capability (fail-closed) from it.
      const slashCommands = readSlashCommandsFromSystemMessage(message);
      if (slashCommands !== undefined) applySlashCommands(slashCommands);
    },
    applySlashCommands,
    clearGoalWorkState() {
      tracker.recordGoalControlIntent({ kind: 'clear' });
      publish(buildEmptyClaudeGoalWorkStateSnapshot({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: Date.now(),
      }));
    },
    recordGoalSetIntent() {
      tracker.recordGoalControlIntent({ kind: 'set' });
    },
  };
}
