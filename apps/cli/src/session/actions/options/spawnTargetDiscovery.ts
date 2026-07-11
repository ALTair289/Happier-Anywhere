import { listDaemonStatusesForAllKnownServers, type DaemonStatusEntry } from '@/daemon/multiDaemon';
import type { Credentials } from '@/persistence';
import { listSessions } from '@/session/services/listSessions';
import {
  normalizeActionOptionLimit,
  normalizeActionOptionString,
} from './actionOptionInputNormalization';

export type SpawnPathDiscoveryItem = Readonly<{
  value: string;
  label: string;
  path: string;
  host?: string;
  machineId?: string;
  sessionId: string;
  activeAt?: number;
}>;

export type SpawnPathDiscoveryResult = Readonly<{
  items: readonly SpawnPathDiscoveryItem[];
}>;

export type SpawnMachineDiscoveryItem = Readonly<{
  value: string;
  label: string;
  machineId: string;
  serverId: string;
  serverName: string;
  authenticated: boolean;
  machineRegistered: boolean;
  daemonRunning: boolean;
}>;

export type SpawnMachineDiscoveryResult = Readonly<{
  items: readonly SpawnMachineDiscoveryItem[];
}>;

export type SpawnServerDiscoveryItem = Readonly<{
  value: string;
  label: string;
  serverId: string;
  serverUrl: string;
  authenticated: boolean;
  needsAuth: boolean;
  machineId: string | null;
  daemonRunning: boolean;
}>;

export type SpawnServerDiscoveryResult = Readonly<{
  items: readonly SpawnServerDiscoveryItem[];
}>;

export async function listRecentSpawnPathItems(params: Readonly<{
  credentials: Credentials;
  machineId?: unknown;
  limit?: unknown;
}>): Promise<SpawnPathDiscoveryResult> {
  const limit = normalizeActionOptionLimit(params.limit) ?? 20;
  const machineId = normalizeActionOptionString(params.machineId);
  const result = await listSessions({
    credentials: params.credentials,
    activeOnly: false,
    archivedOnly: false,
    includeSystem: false,
    resumableOnly: false,
    limit: Math.max(limit * 4, limit),
  });

  const seen = new Set<string>();
  const items: SpawnPathDiscoveryItem[] = [];
  for (const session of result.sessions) {
    const sessionRecord = session as { path?: unknown; host?: unknown; machineId?: unknown };
    const path = normalizeActionOptionString(sessionRecord.path);
    if (!path) continue;
    const host = normalizeActionOptionString(sessionRecord.host);
    const sessionMachineId = normalizeActionOptionString(sessionRecord.machineId);
    if (machineId) {
      const matchesMachine = sessionMachineId
        ? sessionMachineId === machineId
        : host === machineId;
      if (!matchesMachine) continue;
    }
    const key = `${sessionMachineId ?? host ?? ''}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      value: path,
      label: path,
      path,
      ...(host ? { host } : {}),
      ...(sessionMachineId ? { machineId: sessionMachineId } : {}),
      sessionId: session.id,
      ...(typeof session.activeAt === 'number' && Number.isFinite(session.activeAt) ? { activeAt: session.activeAt } : {}),
    });
    if (items.length >= limit) break;
  }

  return { items };
}

async function readSpawnTargetServerStatuses(): Promise<DaemonStatusEntry[]> {
  try {
    return await listDaemonStatusesForAllKnownServers();
  } catch {
    return [];
  }
}

export async function listSpawnMachineItems(params: Readonly<{ limit?: unknown }>): Promise<SpawnMachineDiscoveryResult> {
  const limit = normalizeActionOptionLimit(params.limit) ?? 50;
  const seen = new Set<string>();
  const items: SpawnMachineDiscoveryItem[] = [];
  for (const status of await readSpawnTargetServerStatuses()) {
    const machineId = normalizeActionOptionString(status.auth?.machineId);
    if (!machineId || seen.has(machineId)) continue;
    seen.add(machineId);
    items.push({
      value: machineId,
      label: machineId,
      machineId,
      serverId: status.serverId,
      serverName: status.name,
      authenticated: status.auth?.authenticated === true,
      machineRegistered: status.auth?.machineRegistered === true,
      daemonRunning: status.daemon.running === true,
    });
    if (items.length >= limit) break;
  }
  return { items };
}

export async function listSpawnServerItems(params: Readonly<{ limit?: unknown }>): Promise<SpawnServerDiscoveryResult> {
  const limit = normalizeActionOptionLimit(params.limit) ?? 50;
  const items: SpawnServerDiscoveryItem[] = (await readSpawnTargetServerStatuses()).slice(0, limit).map((status) => ({
    value: status.serverId,
    label: status.name,
    serverId: status.serverId,
    serverUrl: status.serverUrl,
    authenticated: status.auth?.authenticated === true,
    needsAuth: status.auth?.needsAuth === true,
    machineId: status.auth?.machineId ?? null,
    daemonRunning: status.daemon.running === true,
  }));
  return { items };
}
