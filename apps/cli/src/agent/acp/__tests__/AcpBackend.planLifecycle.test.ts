import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { NormalizedAcpPlanSnapshot } from '../plans';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('AcpBackend stable plan lifecycle updates', () => {
  it('routes SDK-parsed update and removal notifications through the canonical projection', async () => {
    await withTempDir('happier-acp-plan-lifecycle-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-acp-plan-lifecycle-agent.mjs',
        source: `
          let buffer = '';
          function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
          function update(sessionUpdate) {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: 'provider-session-1', update: sessionUpdate },
            });
          }
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
                setTimeout(() => {
                  update({ sessionUpdate: 'plan_update', plan: {
                    type: 'items', planId: ' exact-plan-id ',
                    entries: [{ content: 'Implement', priority: 'high', status: 'in_progress' }],
                  } });
                  update({ sessionUpdate: 'plan_update', plan: {
                    type: 'markdown', planId: ' exact-plan-id ', content: '# Revised',
                  } });
                  update({ sessionUpdate: 'plan_update', plan: {
                    type: 'file', planId: ' exact-plan-id ', uri: 'file:///workspace/PLAN.md',
                  } });
                  update({ sessionUpdate: 'plan_removed', planId: ' exact-plan-id ' });
                }, 25);
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
      const published: NormalizedAcpPlanSnapshot[] = [];
      backend.setPlanStatePublisher(async (snapshot) => { published.push(snapshot); });

      try {
        await backend.startSession();
        await expect.poll(() => published, { timeout: 5_000 }).toHaveLength(4);
        expect(published).toEqual([
          expect.objectContaining({
            correlationId: ' exact-plan-id ',
            items: [{ title: 'Implement', priority: 'high', status: 'active', order: 0 }],
          }),
          expect.objectContaining({
            correlationId: ' exact-plan-id ', markdown: '# Revised', items: [],
          }),
          expect.objectContaining({
            correlationId: ' exact-plan-id ', fileUri: 'file:///workspace/PLAN.md', items: [],
          }),
          expect.objectContaining({ correlationId: ' exact-plan-id ', items: [] }),
        ]);
      } finally {
        await backend.dispose();
      }
    });
  });
});
