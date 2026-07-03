import {
  ConnectedServiceIdSchema,
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceCredentialUpdateRef = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

export function readConnectedServiceCredentialUpdateRefsFromAccountUpdate(update: unknown): ConnectedServiceCredentialUpdateRef[] {
  const body = update && typeof update === 'object' ? (update as Readonly<{ body?: unknown }>).body : null;
  if (!body || typeof body !== 'object') return [];
  const record = body as Readonly<{ t?: unknown; connectedServicesV2?: unknown }>;
  if (record.t !== 'update-account') return [];
  if (!Array.isArray(record.connectedServicesV2)) return [];

  const out: ConnectedServiceCredentialUpdateRef[] = [];
  const seen = new Set<string>();
  for (const rawService of record.connectedServicesV2) {
    if (!rawService || typeof rawService !== 'object') continue;
    const serviceRecord = rawService as Readonly<{ serviceId?: unknown; profiles?: unknown }>;
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceRecord.serviceId);
    if (!parsedServiceId.success || !Array.isArray(serviceRecord.profiles)) continue;
    for (const rawProfile of serviceRecord.profiles) {
      if (!rawProfile || typeof rawProfile !== 'object') continue;
      const profileRecord = rawProfile as Readonly<{ profileId?: unknown; status?: unknown }>;
      if (!isConnectedServiceCredentialHealthStatusUsable(
        normalizeConnectedServiceCredentialHealthStatus(profileRecord.status),
      )) continue;
      const profileId = typeof profileRecord.profileId === 'string' ? profileRecord.profileId.trim() : '';
      if (!profileId) continue;
      const key = `${parsedServiceId.data}\u0000${profileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ serviceId: parsedServiceId.data, profileId });
    }
  }
  return out;
}
