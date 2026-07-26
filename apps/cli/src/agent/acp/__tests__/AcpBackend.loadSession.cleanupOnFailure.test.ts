import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const src = `
    const decoder = new TextDecoder();
    let buf = '';
    let loadCount = 0;

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function err(id, message, details) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message, data: { details } } });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try {
          req = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!req || typeof req !== 'object') continue;

        const id = req.id;
        const method = req.method;
        const params = req.params;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/load') {
          loadCount += 1;
          if (loadCount <= 3) {
            err(id, 'Internal error', 'No previous sessions found for this project.');
            continue;
          }
          ok(id, { sessionId: params?.sessionId ?? 'loaded-session' });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend loadSession cleanup on failure', () => {
  it('captures transcript replay notifications emitted during session/load before live generation filtering', async () => {
    await withTempDir('happier-acp-load-replay-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-acp-replay-agent.mjs',
        source: `
          import readline from 'node:readline';
          const rl = readline.createInterface({ input: process.stdin });
          const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
          rl.on('line', (line) => {
            const request = JSON.parse(line);
            if (request.method === 'initialize') {
              send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: [] } });
              return;
            }
            if (request.method === 'session/load') {
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: request.params.sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'restored transcript' },
                  },
                },
              });
              send({ jsonrpc: '2.0', id: request.id, result: { sessionId: request.params.sessionId } });
              return;
            }
            send({ jsonrpc: '2.0', id: request.id, result: {} });
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      try {
        await expect(backend.loadSessionWithReplayCapture('resume-1')).resolves.toEqual({
          sessionId: 'resume-1',
          replay: [{ type: 'message', role: 'agent', text: 'restored transcript' }],
        });
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('allows a second loadSession attempt after an upstream load failure without staying initialized', async () => {
    await withTempDir('happier-acp-load-cleanup-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        await expect(backend.loadSession('resume-1')).rejects.toThrow(/No previous sessions found for this project/);
        await expect(backend.loadSession('resume-1')).rejects.toThrow(/No previous sessions found for this project/);
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  }, 20_000);
});
