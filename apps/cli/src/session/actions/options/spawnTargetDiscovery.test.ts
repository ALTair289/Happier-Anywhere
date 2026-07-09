import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { listSessions } = vi.hoisted(() => ({
  listSessions: vi.fn(),
}));

vi.mock('@/session/services/listSessions', () => ({
  listSessions,
}));

import { listRecentSpawnPathItems } from './spawnTargetDiscovery';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

describe('listRecentSpawnPathItems', () => {
  beforeEach(() => {
    listSessions.mockReset();
  });

  it('filters recent paths by machine id instead of host and returns the machine id', async () => {
    listSessions.mockResolvedValue({
      sessions: [
        {
          id: 'sess-1',
          path: '/repo/target',
          host: 'same-host',
          machineId: 'machine-a',
          activeAt: 30,
        },
        {
          id: 'sess-2',
          path: '/repo/other',
          host: 'same-host',
          machineId: 'machine-b',
          activeAt: 20,
        },
      ],
    });

    const result = await listRecentSpawnPathItems({
      credentials: createCredentials(),
      machineId: 'machine-a',
      limit: 10,
    });

    expect(result.items).toEqual([
      {
        value: '/repo/target',
        label: '/repo/target',
        path: '/repo/target',
        host: 'same-host',
        machineId: 'machine-a',
        sessionId: 'sess-1',
        activeAt: 30,
      },
    ]);
  });
});
