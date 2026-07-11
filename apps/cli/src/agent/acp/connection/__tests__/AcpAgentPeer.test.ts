import { agent, RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { createAcpClientConnection } from '../createAcpClientConnection';

const objectParams = { parse: (value: unknown) => value };

function createConnection(testAgent: ReturnType<typeof agent>) {
  return createAcpClientConnection({
    name: 'peer-test-client',
    transport: testAgent,
    handlers: {
      requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: () => {},
    },
  });
}

describe('AcpAgentPeer', () => {
  it('cancels an outgoing extension request and rejects promptly when its signal aborts', async () => {
    let observedCancellation = false;
    let resolveStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const testAgent = agent({ name: 'peer-abort-test-agent' })
      .onRequest('example/slow', objectParams, async (context) => {
        resolveStarted?.();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            observedCancellation = true;
            reject(RequestError.requestCancelled());
          }, { once: true });
        });
        return {};
      });
    const connection = createConnection(testAgent);
    const controller = new AbortController();

    try {
      const request = connection.peer.requestExtension(
        'example/slow',
        {},
        { signal: controller.signal },
      );
      await started;
      controller.abort(new Error('caller cancelled'));

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(observedCancellation).toBe(true);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('times out an outgoing extension request without leaving it active', async () => {
    let observedCancellation = false;
    const testAgent = agent({ name: 'peer-timeout-test-agent' })
      .onRequest('example/slow', objectParams, async (context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            observedCancellation = true;
            reject(RequestError.requestCancelled());
          }, { once: true });
        });
        return {};
      });
    const connection = createConnection(testAgent);

    try {
      await expect(connection.peer.requestExtension(
        'example/slow',
        {},
        { timeoutMs: 25 },
      )).rejects.toThrow(/timed out/i);
      expect(observedCancellation).toBe(true);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('rejects new requests after the connection is disposed', async () => {
    const connection = createConnection(agent({ name: 'peer-dispose-test-agent' }));
    connection.close();
    await connection.closed;

    await expect(connection.peer.requestExtension('example/after-close', {}))
      .rejects.toThrow(/connection is closed/i);
  });
});
