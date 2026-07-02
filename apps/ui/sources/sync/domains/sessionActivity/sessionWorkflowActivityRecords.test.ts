import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type SessionSystemRecord,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';
import { makeSessionWorkflowRunSnapshot } from '@/dev/testkit';

const decryptRaw = vi.fn((_ciphertext: string): Promise<unknown> => Promise.resolve(null));
const getSessionEncryption = vi.fn((_sessionId: string): { decryptRaw: typeof decryptRaw } | null => null);
const fetchSessionSystemRecord = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: { encryption: { getSessionEncryption: (id: string) => getSessionEncryption(id) } },
}));
vi.mock('@/sync/ops/sessionSystemRecords', () => ({
    fetchSessionSystemRecord: (...args: unknown[]) => fetchSessionSystemRecord(...args),
}));

import {
    fetchWorkflowRunSnapshot,
    openWorkflowRunSystemRecord,
    openWorkflowRunSystemRecordContent,
} from './sessionWorkflowActivityRecords';

const snapshot: SessionWorkflowRunSnapshotV1 = makeSessionWorkflowRunSnapshot({
    runId: 'wf_1',
    title: 'Implement',
    totalAgents: 1,
    agents: [{ id: 'a', title: 'A', status: 'active', updatedAt: 1 }],
});

function record(over: Partial<SessionSystemRecord>): SessionSystemRecord {
    return {
        id: 'rec_1',
        sessionId: 'sess_1',
        namespace: 'activity',
        kind: 'workflow_run.v1',
        localId: 'activity:workflow_run:v1:wf_1',
        content: { t: 'plain', v: snapshot },
        createdAt: '2026-06-26T00:00:00.000Z',
        updatedAt: '2026-06-26T00:00:00.000Z',
        ...over,
    };
}

beforeEach(() => {
    decryptRaw.mockReset();
    getSessionEncryption.mockReset();
    fetchSessionSystemRecord.mockReset();
});

describe('openWorkflowRunSystemRecordContent', () => {
    it('opens plain content without touching encryption', async () => {
        const result = await openWorkflowRunSystemRecordContent({ sessionId: 'sess_1', content: { t: 'plain', v: snapshot } });
        expect(result?.runId).toBe('wf_1');
        expect(getSessionEncryption).not.toHaveBeenCalled();
    });

    it('decrypts encrypted content with the session key', async () => {
        getSessionEncryption.mockReturnValue({ decryptRaw });
        decryptRaw.mockResolvedValue(snapshot);
        const result = await openWorkflowRunSystemRecordContent({ sessionId: 'sess_1', content: { t: 'encrypted', c: 'cipher' } });
        expect(decryptRaw).toHaveBeenCalledWith('cipher');
        expect(result?.runId).toBe('wf_1');
    });

    it('fails soft when there is no session encryption for encrypted content', async () => {
        getSessionEncryption.mockReturnValue(null);
        const result = await openWorkflowRunSystemRecordContent({ sessionId: 'sess_1', content: { t: 'encrypted', c: 'cipher' } });
        expect(result).toBeNull();
    });

    it('fails soft when decryption returns null', async () => {
        getSessionEncryption.mockReturnValue({ decryptRaw });
        decryptRaw.mockResolvedValue(null);
        expect(await openWorkflowRunSystemRecordContent({ sessionId: 'sess_1', content: { t: 'encrypted', c: 'cipher' } })).toBeNull();
    });

    it('fails soft on a malformed plain payload', async () => {
        const result = await openWorkflowRunSystemRecordContent({ sessionId: 'sess_1', content: { t: 'plain', v: { nope: true } } });
        expect(result).toBeNull();
    });

    it('fails soft on stale pre-projection-version plain payloads', async () => {
        const stale: Record<string, unknown> = { ...snapshot };
        delete stale.projectionVersion;
        const result = await openWorkflowRunSystemRecordContent({ sessionId: 'sess_1', content: { t: 'plain', v: stale } });
        expect(result).toBeNull();
    });
});

describe('openWorkflowRunSystemRecord', () => {
    it('returns null for a null record', async () => {
        expect(await openWorkflowRunSystemRecord({ sessionId: 'sess_1', record: null })).toBeNull();
    });

    it('rejects a wrong-namespace record', async () => {
        expect(await openWorkflowRunSystemRecord({ sessionId: 'sess_1', record: record({ namespace: 'memory' as never }) })).toBeNull();
    });

    it('rejects a wrong-kind record', async () => {
        expect(await openWorkflowRunSystemRecord({ sessionId: 'sess_1', record: record({ kind: 'summary_shard.v1' as never }) })).toBeNull();
    });

    it('rejects a record whose localId does not match the expected join id', async () => {
        const result = await openWorkflowRunSystemRecord({
            sessionId: 'sess_1',
            record: record({ localId: 'activity:workflow_run:v1:OTHER' }),
            expectedLocalId: 'activity:workflow_run:v1:wf_1',
        });
        expect(result).toBeNull();
    });

    it('opens a valid record', async () => {
        const result = await openWorkflowRunSystemRecord({ sessionId: 'sess_1', record: record({}) });
        expect(result?.runId).toBe('wf_1');
    });
});

describe('fetchWorkflowRunSnapshot', () => {
    it('builds the join local id and opens the fetched record', async () => {
        fetchSessionSystemRecord.mockResolvedValue(record({}));
        const result = await fetchWorkflowRunSnapshot({ sessionId: 'sess_1', runId: 'wf_1' });
        expect(fetchSessionSystemRecord).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            namespace: 'activity',
            localId: 'activity:workflow_run:v1:wf_1',
        }));
        expect(result?.runId).toBe('wf_1');
    });

    it('returns null when the record is missing', async () => {
        fetchSessionSystemRecord.mockResolvedValue(null);
        expect(await fetchWorkflowRunSnapshot({ sessionId: 'sess_1', runId: 'wf_1' })).toBeNull();
    });
});
