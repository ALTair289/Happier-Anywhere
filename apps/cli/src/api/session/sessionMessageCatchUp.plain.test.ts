import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}));

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

import axios from 'axios';

import { HttpStatusError } from '@/api/client/httpStatusError';

import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('sessionMessageCatchUp (plaintext envelopes)', () => {
  it('emits new-message updates for plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: ' l1 ',
            sidechainId: ' sc-1 ',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1/sessions/s1/messages'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer t',
        }),
      }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.t).toBe('new-message');
    expect(updates[0]?.body?.message?.content?.t).toBe('plain');
    expect(updates[0]?.body?.message?.localId).toBe(' l1 ');
    expect(updates[0]?.body?.message?.sidechainId).toBe(' sc-1 ');
    expect(updates[0]?.body?.message?.createdAt).toBe(123);
    expect(updates[0]?.body?.message?.updatedAt).toBe(123);
  });

  it('preserves missing transcript timestamps as unavailable in catch-up updates', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.updatedAt).toBeNull();
  });

  it('projects catch-up history without feeding current-turn observation', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'historical-agent-message',
            seq: 13,
            localId: 'historical-agent-local',
            createdAt: 123,
            updatedAt: 456,
            content: {
              t: 'plain',
              v: { role: 'agent', content: { type: 'text', text: 'historical output' } },
            },
          },
        ],
      },
    } as any);
    const onObservedMessage = vi.fn();
    const emit = vi.fn();

    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (update) => {
        handleSessionNewMessageUpdate({
          update,
          sessionId: 's1',
          encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy',
          receivedMessageIds: new Set<string>(),
          replayPreviouslyObservedMessageIdsForObservation: true,
          lastObservedMessageSeq: 10,
          lastObservedUserMessageSeq: 0,
          hasSelfEchoSuppressedLocalId: () => false,
          hasPendingQueueMaterializedLocalId: () => false,
          deleteMaterializedLocalId: () => undefined,
          onObservedMessage,
          emit,
          debug: () => undefined,
          debugLargeJson: () => undefined,
        });
      },
    });

    expect(onObservedMessage).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('message', expect.objectContaining({
      createdAt: 123,
      serverCreatedAt: 123,
    }));
  });

  it('ignores transcript messages with malformed seq values', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: '12',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(0);
  });

  it('throws terminal auth responses instead of treating them as empty catch-up', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 401,
      data: { messages: [] },
    } as any);

    await expect(
      catchUpSessionMessagesAfterSeq({
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 401 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });

  it('normalizes axios-style rejected auth errors into the canonical auth carrier', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce({
      response: {
        status: 403,
      },
    });

    await expect(
      catchUpSessionMessagesAfterSeq({
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 403 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });
});
