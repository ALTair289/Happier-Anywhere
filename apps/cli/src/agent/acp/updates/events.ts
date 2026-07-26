import type { HandlerContext, HandlerResult, SessionUpdate } from './types';
import { normalizeAcpPlan } from '../plans';
import {
  ProviderSessionTitleSchema,
  ProviderSessionUpdatedAtSchema,
} from '@happier-dev/protocol';

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractThinkingText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.trim().length > 0 ? payload : null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const textCandidate = record.text ?? record.message ?? record.content;
  if (typeof textCandidate !== 'string') return null;
  return textCandidate.trim().length > 0 ? textCandidate : null;
}

export function handleAvailableCommandsUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const commands = Array.isArray(update.availableCommands) ? update.availableCommands : null;
  if (!commands) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'available_commands_update',
    payload: { availableCommands: commands },
  });
  return { handled: true };
}

export function readCurrentModeId(update: SessionUpdate): string | null {
  return typeof update.currentModeId === 'string'
    && update.currentModeId.trim().length > 0
    && update.currentModeId.length <= 256
    ? update.currentModeId
    : null;
}

export function handleCurrentModeUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const modeId = readCurrentModeId(update);
  if (!modeId) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'current_mode_update',
    payload: { currentModeId: modeId },
  });
  return { handled: true };
}

export function handleSessionInfoUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const payload: { title?: string | null; updatedAt?: string | null } = {};

  if (hasOwn(update, 'title')) {
    if (update.title === null) {
      payload.title = null;
    } else if (typeof update.title === 'string') {
      const parsed = ProviderSessionTitleSchema.safeParse(update.title);
      if (parsed.success) payload.title = parsed.data;
    }
  }

  if (hasOwn(update, 'updatedAt')) {
    if (update.updatedAt === null) {
      payload.updatedAt = null;
    } else if (typeof update.updatedAt === 'string') {
      const parsed = ProviderSessionUpdatedAtSchema.safeParse(update.updatedAt);
      if (parsed.success) payload.updatedAt = parsed.data;
    }
  }

  if (Object.keys(payload).length > 0) {
    ctx.emit({ type: 'event', name: 'session_info_update', payload });
  }
  return { handled: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readOpaquePlanId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Standard ACP plan updates are complete snapshots. Route them into the same
 * replace/merge/fingerprint owner used by proprietary plan adapters; presentation
 * happens through canonical session work state, never synthetic TodoWrite history.
 */
export async function handlePlanUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  if (!ctx.turnId || !ctx.plans) return { handled: false };

  if (update.sessionUpdate === 'plan_removed') {
    const correlationId = readOpaquePlanId(update.planId);
    if (!correlationId) return { handled: false };
    await ctx.plans.remove({
      providerId: ctx.transport.agentName,
      turnId: ctx.turnId,
      correlationId,
      source: 'standard',
    });
    return { handled: true };
  }

  let correlationId: string | undefined;
  let markdown: string | undefined;
  let fileUri: string | undefined;
  let entries: unknown[] | null = null;

  if (update.sessionUpdate === 'plan') {
    entries = Array.isArray(update.entries) ? update.entries : null;
  } else if (update.sessionUpdate === 'plan_update') {
    const plan = asRecord(update.plan);
    correlationId = readOpaquePlanId(plan?.planId) ?? undefined;
    if (!plan || !correlationId) return { handled: false };
    if (plan.type === 'items' && Array.isArray(plan.entries)) {
      entries = plan.entries;
    } else if (plan.type === 'markdown' && typeof plan.content === 'string') {
      markdown = plan.content;
      entries = [];
    } else if (plan.type === 'file' && typeof plan.uri === 'string') {
      fileUri = plan.uri;
      entries = [];
    }
  }
  if (!entries) return { handled: false };

  const normalized = normalizeAcpPlan({
    providerId: ctx.transport.agentName,
    turnId: ctx.turnId,
    ...(correlationId ? { correlationId } : {}),
    source: 'standard',
    merge: false,
    ...(markdown !== undefined ? { markdown } : {}),
    ...(fileUri !== undefined ? { fileUri } : {}),
    items: entries,
  });
  if (normalized) await ctx.plans.project(normalized);
  return { handled: true };
}

/**
 * Handle explicit thinking field.
 */
export function handleThinkingUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractThinkingText(update.thinking);
  if (!text) {
    return { handled: false };
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  return { handled: true };
}
