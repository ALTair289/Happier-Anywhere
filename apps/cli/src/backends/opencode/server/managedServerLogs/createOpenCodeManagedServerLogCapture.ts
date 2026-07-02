import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

import { configuration } from '@/configuration';

import {
  formatOpenCodeManagedServerLogTimestamp,
  resolveOpenCodeManagedServerLogPath,
} from './resolveOpenCodeManagedServerLogPath';
import type {
  OpenCodeManagedServerLogCapture,
  OpenCodeManagedServerLogHeader,
  OpenCodeManagedServerLogSource,
} from './openCodeManagedServerLogTypes';

function buildHeaderText(header: OpenCodeManagedServerLogHeader): string {
  const lines = [
    '# OpenCode managed server log',
    `# started: ${header.startedAtIso}`,
    `# command: ${[header.commandBasename, ...header.args].join(' ')}`,
    `# host: ${header.hostname} port: ${header.port}`,
    `# baseUrl: ${header.baseUrl}`,
    `# spawnPid: ${header.spawnPid}`,
    `# launchFingerprint: ${header.launchFingerprint ?? '(none)'}`,
    '# NOTE: no environment values, auth headers, or tokens are recorded here.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Create a best-effort durable log capture for a managed `opencode serve` process. On any I/O
 * failure the capture degrades to a no-op (still draining the caller's pipes via the data listener),
 * so logging can never break the managed server. The `logPath` is always returned so callers can
 * surface it in state/errors.
 */
export function createOpenCodeManagedServerLogCapture(params: Readonly<{
  logsDir?: string;
  port: number;
  spawnPid: number;
  commandBasename: string;
  args: readonly string[];
  hostname: string;
  baseUrl: string;
  launchFingerprint?: string;
  now?: Date;
}>): OpenCodeManagedServerLogCapture {
  const now = params.now ?? new Date();
  const logsDir = params.logsDir ?? configuration.logsDir;
  const logPath = resolveOpenCodeManagedServerLogPath({
    logsDir,
    port: params.port,
    pid: params.spawnPid,
    now,
  });

  let stream: WriteStream | null = null;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    stream = createWriteStream(logPath, { flags: 'a' });
    // Swallow late stream errors (e.g. disk full) so the managed server is never affected.
    stream.on('error', () => {
      stream = null;
    });
    stream.write(buildHeaderText({
      commandBasename: params.commandBasename,
      args: params.args,
      hostname: params.hostname,
      port: params.port,
      spawnPid: params.spawnPid,
      baseUrl: params.baseUrl,
      ...(params.launchFingerprint ? { launchFingerprint: params.launchFingerprint } : {}),
      startedAtIso: now.toISOString(),
    }));
  } catch {
    stream = null;
  }

  // Per-source line buffering so each persisted line is prefixed with its source + timestamp.
  const lineBuffers: Record<OpenCodeManagedServerLogSource, string> = { stdout: '', stderr: '' };

  const writeRaw = (text: string): void => {
    if (!stream || text.length === 0) return;
    try {
      stream.write(text);
    } catch {
      // best-effort
    }
  };

  const emitLine = (source: OpenCodeManagedServerLogSource, line: string): void => {
    writeRaw(`[${formatOpenCodeManagedServerLogTimestamp(new Date())}] [${source}] ${line}\n`);
  };

  const write = (source: OpenCodeManagedServerLogSource, chunk: Buffer | string): void => {
    if (!stream) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const combined = lineBuffers[source] + text;
    const segments = combined.split('\n');
    lineBuffers[source] = segments.pop() ?? '';
    for (const line of segments) emitLine(source, line);
  };

  const flushLineBuffers = (): void => {
    for (const source of ['stdout', 'stderr'] as const) {
      const remainder = lineBuffers[source];
      if (remainder.length > 0) {
        lineBuffers[source] = '';
        emitLine(source, remainder);
      }
    }
  };

  return {
    logPath,
    write,
    recordTrackedPid: (pid: number) => writeRaw(`# trackedPid: ${pid}\n`),
    recordNote: (note: string) => writeRaw(`# ${note}\n`),
    close: async () => {
      flushLineBuffers();
      const current = stream;
      stream = null;
      if (!current) return;
      await new Promise<void>((resolve) => {
        try {
          current.end(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
