import { createHash } from 'node:crypto';
import { buildDeterministicSessionWorkStateItemId } from '@happier-dev/protocol';

import {
  mergeSessionWorkStateMetadataV1,
  type SessionWorkStateV1,
} from '@/session/workState/sessionWorkStateMetadata';
import type { NormalizedAcpPlanSnapshot } from './types';

const ACP_PLAN_WORK_STATE_SOURCE_FAMILY = 'acp.plan';
const PREFIX_MARKER = '__prefix_marker__';

function sourceFamily(providerId: string): string {
  return `${ACP_PLAN_WORK_STATE_SOURCE_FAMILY}.${providerId}`;
}

function exactVendorRefStablePart(vendorRef: string): string {
  const digest = createHash('sha256')
    .update('happier-acp-plan-item-v1\0', 'utf8')
    .update(vendorRef, 'utf8')
    .digest('base64url');
  return `ref-v1:${digest}`;
}

export function resolveAcpPlanWorkStateItemPrefix(providerId: string): string {
  const markerId = buildDeterministicSessionWorkStateItemId({
    kind: 'todo',
    sourceFamily: sourceFamily(providerId),
    stableParts: [PREFIX_MARKER],
  });
  return markerId.slice(0, -PREFIX_MARKER.length);
}

export function buildAcpPlanWorkState(params: Readonly<{
  snapshot: NormalizedAcpPlanSnapshot;
  updatedAt: number;
}>): SessionWorkStateV1 {
  const items = params.snapshot.items.map((item, index) => ({
    id: buildDeterministicSessionWorkStateItemId({
      kind: 'todo',
      sourceFamily: sourceFamily(params.snapshot.providerId),
      stableParts: [
        item.vendorRef ? exactVendorRefStablePart(item.vendorRef) : `${item.title}|${index}`,
      ],
    }),
    kind: 'todo' as const,
    origin: 'vendor' as const,
    status: item.status,
    title: item.title,
    backendId: params.snapshot.providerId,
    ...(item.vendorRef ? { vendorRef: item.vendorRef } : {}),
    order: index,
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.phaseId ? { phaseId: item.phaseId } : {}),
    ...(item.phaseName ? { phaseName: item.phaseName } : {}),
    updatedAt: params.updatedAt,
  }));
  return {
    v: 1,
    backendId: params.snapshot.providerId,
    updatedAt: params.updatedAt,
    items,
    primaryItemId: items.find((item) => item.status === 'active')?.id
      ?? items.find((item) => item.status === 'pending')?.id
      ?? null,
  };
}

export function applyAcpPlanSnapshotToMetadata(params: Readonly<{
  metadata: unknown;
  snapshot: NormalizedAcpPlanSnapshot;
  updatedAt: number;
}>): Record<string, unknown> {
  return mergeSessionWorkStateMetadataV1({
    metadata: params.metadata,
    nextOwned: buildAcpPlanWorkState({ snapshot: params.snapshot, updatedAt: params.updatedAt }),
    ownedItemIdPrefixes: [resolveAcpPlanWorkStateItemPrefix(params.snapshot.providerId)],
  });
}
