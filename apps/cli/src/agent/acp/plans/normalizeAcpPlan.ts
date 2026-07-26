import type {
  AcpPlanInput,
  NormalizedAcpPlanItem,
  NormalizedAcpPlanSnapshot,
} from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readOpaqueId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeStatus(value: unknown): NormalizedAcpPlanItem['status'] {
  const status = readNonEmptyString(value)?.toLowerCase().replaceAll('-', '_');
  if (status === 'inprogress' || status === 'in_progress' || status === 'active') return 'active';
  if (status === 'completed' || status === 'complete' || status === 'done') return 'complete';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'paused') return 'paused';
  if (status === 'blocked') return 'blocked';
  if (status === 'unknown') return 'unknown';
  return 'pending';
}

function normalizeItem(value: unknown, order: number): NormalizedAcpPlanItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = readNonEmptyString(record.content)
    ?? readNonEmptyString(record.title)
    ?? readNonEmptyString(record.text);
  if (!title) return null;
  const vendorRef = readOpaqueId(record.vendorRef) ?? readOpaqueId(record.id);
  const priority = readNonEmptyString(record.priority);
  const phaseId = readNonEmptyString(record.phaseId);
  const phaseName = readNonEmptyString(record.phaseName);
  return {
    ...(vendorRef ? { vendorRef } : {}),
    title,
    status: normalizeStatus(record.status),
    order,
    ...(priority ? { priority } : {}),
    ...(phaseId ? { phaseId } : {}),
    ...(phaseName ? { phaseName } : {}),
  };
}

export function normalizeAcpPlan(input: AcpPlanInput): NormalizedAcpPlanSnapshot | null {
  const providerId = readNonEmptyString(input.providerId);
  const turnId = readNonEmptyString(input.turnId);
  if (!providerId || !turnId) return null;
  const correlationId = readOpaqueId(input.correlationId);
  const items = input.items.flatMap((item, index): NormalizedAcpPlanItem[] => {
    const normalized = normalizeItem(item, index);
    return normalized ? [normalized] : [];
  });
  return {
    providerId,
    turnId,
    ...(correlationId ? { correlationId } : {}),
    source: input.source,
    merge: input.merge,
    ...(typeof input.markdown === 'string' && input.markdown.length > 0
      ? { markdown: input.markdown }
      : {}),
    ...(typeof input.fileUri === 'string' && input.fileUri.length > 0
      ? { fileUri: input.fileUri }
      : {}),
    items,
  };
}
