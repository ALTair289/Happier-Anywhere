import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('AcpBackend session info updates', () => {
  it('routes the standard update without forwarding opaque provider metadata', async () => {
    await withTempDir('happier-acp-session-info-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-acp-session-info-agent.mjs',
        source: `
          let buffer = '';
          function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
          process.stdin.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const message = JSON.parse(line);
              if (message.method === 'initialize') {
                send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [] } });
              } else if (message.method === 'session/new') {
                send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'provider-session-1' } });
                setTimeout(() => send({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'provider-session-1',
                    update: {
                      sessionUpdate: 'session_info_update',
                      title: 'Provider title',
                      updatedAt: '2026-07-11T10:00:00.000Z',
                      _meta: { providerPrivate: 'do-not-forward' },
                    },
                  },
                }), 50);
              } else if (message.id !== undefined) {
                send({ jsonrpc: '2.0', id: message.id, result: {} });
              }
            }
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });
      const events: unknown[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event' && message.name === 'session_info_update') events.push(message);
      });

      try {
        await backend.startSession();
        await expect.poll(() => events).toEqual([{
          type: 'event',
          name: 'session_info_update',
          payload: { title: 'Provider title', updatedAt: '2026-07-11T10:00:00.000Z' },
        }]);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('keeps session metadata and mode updates routable after a prompt turn closes', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: process.execPath,
      args: [],
    });
    const events: unknown[] = [];
    backend.onMessage((message) => {
      if (message.type === 'event') events.push(message);
    });

    const internal = backend as unknown as {
      waitingForResponse: boolean;
      turnGeneration: number;
      closedTurnGeneration: number | null;
      handleSessionUpdate: (params: unknown) => Promise<void>;
    };
    internal.waitingForResponse = false;
    internal.closedTurnGeneration = internal.turnGeneration;

    await internal.handleSessionUpdate({
      sessionId: 'provider-session-1',
      update: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late prompt content' },
        },
        {
          sessionUpdate: 'session_info_update',
          title: 'Post-turn provider title',
        },
        {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'plan',
        },
      ],
    });

    expect(events).toEqual([
      {
        type: 'event',
        name: 'session_info_update',
        payload: { title: 'Post-turn provider title' },
      },
      {
        type: 'event',
        name: 'current_mode_update',
        payload: { currentModeId: 'plan' },
      },
    ]);
  });
});
