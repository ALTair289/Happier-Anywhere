import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { encrypt } from '../encryption';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

type HandlerParams = Parameters<typeof handleSessionNewMessageUpdate>[0];

function buildUpdate(params: Readonly<{
  id?: string;
  messageId?: string;
  seq?: number;
  localId?: string | null;
  content: unknown;
  sourceCreatedAt?: number;
  sourceUpdatedAt?: number;
  transcriptObservationProvenance?: unknown;
}>): Update {
  const now = Date.now();
  return {
    id: params.id ?? 'update-1',
    createdAt: now,
    body: {
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: params.messageId ?? 'message-1',
        seq: params.seq ?? 1,
        localId: params.localId ?? null,
        content: params.content,
        createdAt: now,
        updatedAt: now,
        ...(params.sourceCreatedAt === undefined ? {} : { sourceCreatedAt: params.sourceCreatedAt }),
        ...(params.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: params.sourceUpdatedAt }),
        ...(params.transcriptObservationProvenance === undefined
          ? {}
          : { transcriptObservationProvenance: params.transcriptObservationProvenance }),
      },
    },
  } as unknown as Update;
}

function createParams(update: Update, overrides: Partial<HandlerParams> = {}): HandlerParams {
  return {
    update,
    sessionId: 'sess_1',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    receivedMessageIds: new Set<string>(),
    lastObservedMessageSeq: 0,
    lastObservedUserMessageSeq: 0,
    hasSelfEchoSuppressedLocalId: () => false,
    hasPendingQueueMaterializedLocalId: () => false,
    deleteMaterializedLocalId: () => undefined,
    emit: () => undefined,
    debug: () => undefined,
    debugLargeJson: () => undefined,
    ...overrides,
  };
}

describe('handleSessionNewMessageUpdate', () => {
  it('logs invalid content envelope shapes without leaking string contents', () => {
    const debug = vi.fn();
    const emitted = vi.fn();
    const update = buildUpdate({
      content: { foo: 'bar', secret: 'SUPER_SECRET_VALUE' },
    });

    handleSessionNewMessageUpdate(createParams(update, { debug, emit: emitted }));

    expect(debug).toHaveBeenCalled();
    const calls = JSON.stringify(debug.mock.calls);
    expect(calls).toContain('secret');
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(emitted).not.toHaveBeenCalled();
  });

  it('projects a live structured user transcript row as observation only', () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const observed: unknown[] = [];
    const update = buildUpdate({
      seq: 7,
      localId: 'queue-owned-7',
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: 'observed prompt' },
          localId: 'queue-owned-7',
          meta: { source: 'ui', sentFrom: 'web' },
        },
      },
    });

    const result = handleSessionNewMessageUpdate(createParams(update, {
      onObservedMessage: (message) => observed.push(message),
      emit: (event, payload) => emitted.push({ event, payload }),
    }));

    expect(result).toMatchObject({
      handled: true,
      lastObservedMessageSeq: 7,
      lastObservedUserMessageSeq: 7,
    });
    expect(observed).toHaveLength(1);
    expect(emitted).toEqual([{
      event: 'user-message',
      payload: expect.objectContaining({
        localId: 'queue-owned-7',
        content: { type: 'text', text: 'observed prompt' },
      }),
    }]);
  });

  it('does not trust remote transcript provenance to suppress current-turn observation', () => {
    const observed = vi.fn();
    const emitted = vi.fn();
    const update = buildUpdate({
      seq: 8,
      localId: 'recovered-assistant-8',
      sourceCreatedAt: 1_234,
      sourceUpdatedAt: 1_567,
      transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
      content: {
        t: 'plain',
        v: { role: 'agent', content: { type: 'text', text: 'historical output' } },
      },
    });

    handleSessionNewMessageUpdate(createParams(update, {
      onObservedMessage: observed,
      emit: emitted,
    }));

    expect(observed).toHaveBeenCalledOnce();
    expect(emitted).toHaveBeenCalledWith('message', expect.objectContaining({
      createdAt: expect.any(Number),
    }));
    expect(emitted.mock.calls[0]?.[1]).not.toHaveProperty('sourceCreatedAt');
    expect(emitted.mock.calls[0]?.[1]).not.toHaveProperty('sourceUpdatedAt');
    expect(emitted.mock.calls[0]?.[1]).not.toHaveProperty('transcriptObservationProvenance');
  });

  it('reprocesses an explicit catch-up row only for observation convergence', () => {
    const emitted = vi.fn();
    const update = buildUpdate({
      id: 'catchup-message-6',
      messageId: 'message-6',
      seq: 6,
      localId: 'queue-owned-6',
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: '/context' },
          localId: 'queue-owned-6',
        },
      },
    });

    const result = handleSessionNewMessageUpdate(createParams(update, {
      receivedMessageIds: new Set<string>(['message-6']),
      replayPreviouslyObservedMessageIdsForObservation: true,
      lastObservedMessageSeq: 6,
      lastObservedUserMessageSeq: 5,
      emit: emitted,
    }));

    expect(result.lastObservedUserMessageSeq).toBe(6);
    expect(emitted).toHaveBeenCalledOnce();
    expect(emitted).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'queue-owned-6' }));
  });

  it('keeps an already-observed id deduped without reprocess authorization', () => {
    const emitted = vi.fn();
    const update = buildUpdate({
      messageId: 'message-6',
      seq: 6,
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'duplicate observation' } },
      },
    });

    handleSessionNewMessageUpdate(createParams(update, {
      receivedMessageIds: new Set<string>(['message-6']),
      emit: emitted,
    }));

    expect(emitted).not.toHaveBeenCalled();
  });

  it('coerces a legacy string prompt for observation without provider delivery', () => {
    const emitted = vi.fn();
    const update = buildUpdate({
      content: { t: 'plain', v: { role: 'user', content: 'hello legacy' } },
    });

    handleSessionNewMessageUpdate(createParams(update, { emit: emitted }));

    expect(emitted).toHaveBeenCalledWith('user-message', expect.objectContaining({
      content: { type: 'text', text: 'hello legacy' },
    }));
  });

  it('decrypts a legacy encrypted envelope for observation', () => {
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);
    const ciphertext = Buffer.from(encrypt(encryptionKey, 'legacy', {
      role: 'user',
      content: { type: 'text', text: 'hello encrypted' },
    })).toString('base64');
    const emitted = vi.fn();
    const update = buildUpdate({ content: ciphertext });

    handleSessionNewMessageUpdate(createParams(update, { encryptionKey, emit: emitted }));

    expect(emitted).toHaveBeenCalledWith('user-message', expect.objectContaining({
      content: { type: 'text', text: 'hello encrypted' },
    }));
  });
});
