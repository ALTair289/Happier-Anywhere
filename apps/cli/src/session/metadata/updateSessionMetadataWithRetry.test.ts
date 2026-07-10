import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError';
import { updateSessionMetadataWithRetry } from './updateSessionMetadataWithRetry';

type MetadataAckCallback = (answer: unknown) => void;

class FakeMetadataSocket {
  readonly emitted: Array<Readonly<{ event: string; payload: unknown }>> = [];
  connected: boolean | undefined;
  closeCount = 0;
  disconnectCount = 0;
  private readonly ack: unknown;

  constructor(ack: unknown, options: Readonly<{ connected?: boolean }> = {}) {
    this.ack = ack;
    this.connected = options.connected;
  }

  connect(): void {}

  emit(event: string, payload: unknown, callback?: MetadataAckCallback): void {
    this.emitted.push({ event, payload });
    callback?.(this.ack);
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }
}

const { socketRef } = vi.hoisted(() => ({
  socketRef: { current: null as FakeMetadataSocket | null },
}));

const { patchSessionMetadataMock, waitForSocketConnectMock } = vi.hoisted(() => ({
  patchSessionMetadataMock: vi.fn(),
  waitForSocketConnectMock: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: () => {
    if (!socketRef.current) throw new Error('Missing fake metadata socket');
    // Socket.io is a platform boundary; this fake implements only the methods used by the unit under test.
    return socketRef.current as unknown;
  },
}));

vi.mock('@/session/transport/socket/waitForSocketConnect', () => ({
  waitForSocketConnect: waitForSocketConnectMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  patchSessionMetadata: patchSessionMetadataMock,
}));

vi.mock('@/session/transport/shared/sessionTimeouts', () => ({
  resolveSessionControlSocketAckTimeoutMs: () => 10,
  resolveSessionControlSocketConnectTimeoutMs: () => 10,
}));

describe('updateSessionMetadataWithRetry', () => {
  beforeEach(() => {
    socketRef.current = null;
    patchSessionMetadataMock.mockReset();
    waitForSocketConnectMock.mockReset();
    waitForSocketConnectMock.mockResolvedValue(undefined);
  });

  it('skips socket and HTTP writes when the updater returns unchanged metadata', async () => {
    const result = await updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      sessionId: 'sess_noop',
      rawSession: {
        metadata: '{"path":"/tmp/project"}',
        metadataVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata }),
      maxAttempts: 1,
    });

    expect(result).toEqual({ version: 7, metadata: { path: '/tmp/project' } });
    expect(waitForSocketConnectMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('sends one metadata write when the updater returns a real change', async () => {
    const socket = new FakeMetadataSocket({
      result: 'success',
      version: 8,
      metadata: '{"path":"/tmp/project","title":"Project"}',
    });
    socketRef.current = socket;

    const result = await updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      sessionId: 'sess_real_change',
      rawSession: {
        metadata: '{"path":"/tmp/project"}',
        metadataVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata, title: 'Project' }),
      maxAttempts: 1,
    });

    expect(result).toEqual({ version: 8, metadata: { path: '/tmp/project', title: 'Project' } });
    expect(socket.emitted).toHaveLength(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('sends one metadata write when an updater mutates its input in place', async () => {
    const socket = new FakeMetadataSocket({
      result: 'success',
      version: 8,
      metadata: '{"project":{"path":"/tmp/project","title":"Project"}}',
    });
    socketRef.current = socket;

    const result = await updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      sessionId: 'sess_in_place_change',
      rawSession: {
        metadata: '{"project":{"path":"/tmp/project"}}',
        metadataVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => {
        const project = metadata.project as Record<string, unknown>;
        project.title = 'Project';
        return metadata;
      },
      maxAttempts: 1,
    });

    expect(result).toEqual({ version: 8, metadata: { project: { path: '/tmp/project', title: 'Project' } } });
    expect(socket.emitted).toHaveLength(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('classifies forbidden metadata acks as canonical authentication errors', async () => {
    const socket = new FakeMetadataSocket({ result: 'forbidden' });
    socketRef.current = socket;

    let caught: unknown;
    try {
      await updateSessionMetadataWithRetry({
        token: 'token-1',
        credentials: {
          token: 'token-1',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        sessionId: 'sess_forbidden',
        rawSession: {
          metadata: '{}',
          metadataVersion: 1,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
        },
        updater: (metadata) => ({ ...metadata, title: 'updated' }),
        maxAttempts: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpStatusError);
    expect(caught).toMatchObject({
      response: { status: 403 },
      code: 'not_authenticated',
    });
    expect(isAuthenticationError(caught)).toBe(true);
    expect(socket.emitted).toHaveLength(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(socket.disconnectCount).toBe(1);
    expect(socket.closeCount).toBe(1);
  });

  it('classifies socket connect authentication failures before metadata acks', async () => {
    const socket = new FakeMetadataSocket({ result: 'success', version: 2, metadata: '{}' });
    socketRef.current = socket;
    const socketAuthError = Object.assign(new Error('invalid token'), {
      data: {
        statusCode: 401,
        error: 'invalid-token',
      },
    });
    waitForSocketConnectMock.mockRejectedValue(socketAuthError);

    let caught: unknown;
    try {
      await updateSessionMetadataWithRetry({
        token: 'token-1',
        credentials: {
          token: 'token-1',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        sessionId: 'sess_connect_auth',
        rawSession: {
          metadata: '{}',
          metadataVersion: 1,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
        },
        updater: (metadata) => ({ ...metadata, title: 'updated' }),
        maxAttempts: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(socketAuthError);
    expect(isAuthenticationError(caught)).toBe(true);
    expect(socket.emitted).toHaveLength(0);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(socket.disconnectCount).toBe(1);
    expect(socket.closeCount).toBe(1);
  });

  it('falls back to the HTTP metadata patch when the connected socket is no longer writable', async () => {
    const socket = new FakeMetadataSocket({ result: 'success', version: 2, metadata: '{}' }, { connected: false });
    socketRef.current = socket;
    patchSessionMetadataMock.mockResolvedValue({ success: true, version: 3 });

    const result = await updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      sessionId: 'sess_socket_drop',
      rawSession: {
        metadata: '{}',
        metadataVersion: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata, title: 'updated' }),
      maxAttempts: 1,
    });

    expect(result).toEqual({ version: 3, metadata: { title: 'updated' } });
    expect(socket.emitted).toHaveLength(0);
    expect(patchSessionMetadataMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-1',
      sessionId: 'sess_socket_drop',
      expectedVersion: 1,
    }));
    expect(socket.disconnectCount).toBe(1);
    expect(socket.closeCount).toBe(1);
  });

  it('falls back to the HTTP metadata patch when the socket connect fails with a non-auth transport error', async () => {
    const socket = new FakeMetadataSocket({ result: 'success', version: 2, metadata: '{}' });
    socketRef.current = socket;
    waitForSocketConnectMock.mockRejectedValue(new Error('transport unavailable'));
    patchSessionMetadataMock.mockResolvedValue({ success: true, version: 4 });

    const result = await updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      sessionId: 'sess_connect_transport',
      rawSession: {
        metadata: '{}',
        metadataVersion: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata, mode: 'fallback' }),
      maxAttempts: 1,
    });

    expect(result).toEqual({ version: 4, metadata: { mode: 'fallback' } });
    expect(socket.emitted).toHaveLength(0);
    expect(patchSessionMetadataMock).toHaveBeenCalledTimes(1);
    expect(socket.disconnectCount).toBe(1);
    expect(socket.closeCount).toBe(1);
  });

  it('does not fall back to HTTP when the metadata socket ack returns a semantic failure', async () => {
    const socket = new FakeMetadataSocket({ result: 'error' });
    socketRef.current = socket;

    await expect(updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      sessionId: 'sess_semantic_error',
      rawSession: {
        metadata: '{}',
        metadataVersion: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata, title: 'updated' }),
      maxAttempts: 1,
    })).rejects.toMatchObject({ code: 'unknown_error' });

    expect(socket.emitted).toHaveLength(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(socket.disconnectCount).toBe(1);
    expect(socket.closeCount).toBe(1);
  });
});
