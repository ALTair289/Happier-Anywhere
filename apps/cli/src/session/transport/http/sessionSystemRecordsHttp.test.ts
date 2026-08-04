import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionSystemRecordsHttp', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('upserts a system record through the dedicated session system-record route', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecord } = await import('./sessionSystemRecordsHttp');

    const putSpy = vi.spyOn(axios, 'put').mockResolvedValueOnce({
      status: 200,
      data: {
        record: {
          id: 'rec-1',
          sessionId: 'sess/1',
          namespace: 'memory',
          kind: 'summary_shard.v1',
          localId: 'memory:summary_shard:v1:1-2',
          content: { t: 'plain', v: {
            v: 1,
            seqFrom: 1,
            seqTo: 2,
            createdAtFromMs: 1,
            createdAtToMs: 2,
            summary: 'S',
            keywords: [],
            entities: [],
            decisions: [],
          } },
          createdAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T00:00:00.000Z',
        },
      },
    } as never);

    await expect(
      upsertSessionSystemRecord({
        token: 'token-1',
        sessionId: 'sess/1',
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: 'memory:summary_shard:v1:1-2',
        content: { t: 'plain', v: {
          v: 1,
          seqFrom: 1,
          seqTo: 2,
          createdAtFromMs: 1,
          createdAtToMs: 2,
          summary: 'S',
          keywords: [],
          entities: [],
          decisions: [],
        } },
      }),
    ).resolves.toMatchObject({
      sessionId: 'sess/1',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-2',
    });

    expect(putSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess%2F1/system-records',
      {
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: 'memory:summary_shard:v1:1-2',
        content: { t: 'plain', v: {
          v: 1,
          seqFrom: 1,
          seqTo: 2,
          createdAtFromMs: 1,
          createdAtToMs: 2,
          summary: 'S',
          keywords: [],
          entities: [],
          decisions: [],
        } },
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'Idempotency-Key': 'memory:summary_shard:v1:1-2',
        }),
      }),
    );
  });

  it('fetches paginated, latest, and single memory system records with query params', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const {
      fetchLatestSessionSystemRecord,
      fetchSessionSystemRecord,
      fetchSessionSystemRecordsPage,
    } = await import('./sessionSystemRecordsHttp');

    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          records: [],
          nextCursor: 'cursor-2',
          hasNext: true,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          record: {
            id: 'rec-latest',
            sessionId: 'sess-1',
            namespace: 'memory',
            kind: 'synopsis.v1',
            localId: 'memory:synopsis:v1:10',
            content: { t: 'plain', v: { v: 1, seqTo: 10, updatedAtMs: 99, synopsis: 'S' } },
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:01.000Z',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { record: null },
      } as never);

    await expect(fetchSessionSystemRecordsPage({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-2',
      cursor: 'cursor-1',
      limit: 25,
    })).resolves.toMatchObject({ records: [], nextCursor: 'cursor-2', hasNext: true });

    await expect(fetchLatestSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'synopsis.v1',
    })).resolves.toMatchObject({ localId: 'memory:synopsis:v1:10' });

    await expect(fetchSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      localId: 'memory:synopsis:v1:missing',
    })).resolves.toBeNull();

    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      'http://server.example.test/v2/sessions/sess-1/system-records',
      expect.objectContaining({
        headers: expect.objectContaining({
        }),
        params: {
          namespace: 'memory',
          kind: 'summary_shard.v1',
          localId: 'memory:summary_shard:v1:1-2',
          cursor: 'cursor-1',
          limit: 25,
        },
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      'http://server.example.test/v2/sessions/sess-1/system-records/latest',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          kind: 'synopsis.v1',
        },
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      3,
      'http://server.example.test/v2/sessions/sess-1/system-records/record',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          localId: 'memory:synopsis:v1:missing',
        },
      }),
    );
  });

  it('normalizes auth failures for system-record requests', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchLatestSessionSystemRecord } = await import('./sessionSystemRecordsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(fetchLatestSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'synopsis.v1',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('surfaces required compatibility rejection as a typed terminal error', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionSystemRecordsPage } = await import('./sessionSystemRecordsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 426,
      data: {
        error: 'client-upgrade-required',
        requirement: {
          v: 1,
          clientKind: 'session-runner',
          minimumAppVersion: '9.0.0',
          updateUrl: null,
        },
      },
    } as never);

    await expect(fetchSessionSystemRecordsPage({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'activity',
      kind: 'workflow_run.v1',
    })).rejects.toMatchObject({
      name: 'CliClientUpgradeRequiredError',
      statusCode: 426,
    });
  });
});
