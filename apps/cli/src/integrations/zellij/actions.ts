import { spawn } from 'child_process';
import type { StdioOptions } from 'child_process';

import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';
import { splitBufferByBytes } from '../terminalHost/chunks';
import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '../terminalHost/deadline';
import { acquireZellijActionSlot } from './actionLimiter';

export type ZellijCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

export class ZellijActionTimeoutError extends Error {
  readonly action: string;

  constructor(action: string) {
    super(`zellij ${action} timed out`);
    this.name = 'ZellijActionTimeoutError';
    this.action = action;
  }
}

export function isZellijActionTimeoutError(error: unknown): error is ZellijActionTimeoutError {
  return error instanceof ZellijActionTimeoutError;
}

export type ZellijPane = Readonly<{
  id?: number | string;
  pane_id?: number | string;
  is_plugin?: boolean;
  is_focused?: boolean;
  is_suppressed?: boolean;
  is_held?: boolean;
  terminal_command?: string | null;
  exited?: boolean;
  exit_status?: number | null;
}>;

export type ZellijActionParams = Readonly<{
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
}>;

export type ZellijPaneActionParams = ZellijActionParams & Readonly<{ paneId: string }>;
export type ZellijTimeoutParams = Readonly<{ timeoutMs?: number }>;
export type ZellijRunCommandParams = ZellijActionParams & Readonly<{
  sessionName: string;
  cwd?: string;
  command: readonly string[];
}>;
export type ZellijDetachedCommandHandle = Readonly<{
  pid?: number;
  dispose(): void;
}>;

export type ZellijActions = Readonly<{
  attachCreateBackground(params: ZellijActionParams & Readonly<{
    sessionName: string;
    cwd?: string;
    defaultShell?: string;
  }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  runCommand(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  startCommandDetached?(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijDetachedCommandHandle>;
  pasteText?(params: ZellijPaneActionParams & Readonly<{ text: string; timeoutMs?: number }>): Promise<void>;
  writeBytesChunked(params: ZellijPaneActionParams & Readonly<{ text: string; chunkSize?: number; timeoutMs?: number }>): Promise<void>;
  sendEnter(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void>;
  sendEscape(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void>;
  closePane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
  listSessions?(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  listPanes(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijPane[]>;
  dumpScreen(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<string>;
  killSession(params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  deleteSession(params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
}>;

export type ZellijAttachActions = Readonly<{
  attachForeground(params: ZellijActionParams & Readonly<{ sessionName: string }>): Promise<ZellijCommandResult>;
  focusPane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
}>;

export const DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE = 4096;
export const ZELLIJ_ACTION_PASTE_SAFE_BYTES = {
  darwin: 300_000,
  linux: 65_536,
  win32: 16_384,
  fallback: 65_536,
} as const;

const ZELLIJ_HOST_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'ComSpec',
]);
const ZELLIJ_TIMEOUT_KILL_GRACE_MS = 250;
const DEFAULT_ZELLIJ_ACTION_MAX_CONCURRENCY = 4;

function buildZellijProcessEnv(env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && isAllowedExactEnvKey(key, ZELLIJ_HOST_ENV_KEYS)) {
      base[key] = value;
    }
  }
  return { ...base, ...env };
}

function readZellijActionMaxConcurrency(): number {
  const parsed = Number.parseInt(process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ZELLIJ_ACTION_MAX_CONCURRENCY;
}

async function runZellij(
  params: ZellijActionParams,
  args: readonly string[],
  options?: Readonly<{ cwd?: string; timeoutMs?: number; action?: string; stdio?: StdioOptions; windowsHide?: boolean }>,
): Promise<ZellijCommandResult> {
  const action = options?.action ?? args[0] ?? 'command';
  const timeoutError = () => new ZellijActionTimeoutError(action);
  if (options?.timeoutMs === 0) throw timeoutError();
  // End-to-end semantic: admission and process execution consume one caller deadline.
  const deadline = createTerminalHostDeadline(options?.timeoutMs);
  const releaseSlot = await acquireZellijActionSlot({
    socketDir: params.env.ZELLIJ_SOCKET_DIR,
    maxConcurrency: readZellijActionMaxConcurrency(),
    deadlineMs: deadline,
    timeoutError,
  });
  try {
    const remainingTimeoutMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingTimeoutMs === 0) throw timeoutError();
    return await runZellijUnbounded(
      params,
      args,
      remainingTimeoutMs === undefined
        ? options
        : { ...options, timeoutMs: remainingTimeoutMs },
    );
  } finally {
    await releaseSlot();
  }
}

function runZellijUnbounded(
  params: ZellijActionParams,
  args: readonly string[],
  options?: Readonly<{ cwd?: string; timeoutMs?: number; action?: string; stdio?: StdioOptions; windowsHide?: boolean }>,
): Promise<ZellijCommandResult> {
  return new Promise((resolve, reject) => {
    const stdio = options?.stdio ?? ['ignore', 'pipe', 'pipe'];
    const detached = process.platform !== 'win32';
    const child = spawn(params.zellijBinary, [...args], {
      cwd: options?.cwd,
      env: buildZellijProcessEnv(params.env),
      detached,
      shell: false,
      stdio,
      windowsHide: options?.windowsHide ?? true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutKillGrace: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new ZellijActionTimeoutError(options?.action ?? args[0] ?? 'command');
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (timeoutKillGrace !== undefined) clearTimeout(timeoutKillGrace);
      callback();
    };
    timeout = options?.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminateZellijChild(child);
          timeoutKillGrace = setTimeout(() => {
            finish(() => reject(timeoutError()));
          }, ZELLIJ_TIMEOUT_KILL_GRACE_MS);
          timeoutKillGrace.unref?.();
        }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(timedOut ? timeoutError() : error)));
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          reject(timeoutError());
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  });
}

function terminateZellijChild(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Fall through to direct child signaling. The process may already have exited or may not
      // have a process group on older/embedded runtimes.
    }
  }
  child.kill();
}

function runZellijForeground(
  params: ZellijActionParams,
  args: readonly string[],
): Promise<ZellijCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.zellijBinary, [...args], {
      env: buildZellijProcessEnv(params.env),
      shell: false,
      stdio: 'inherit',
      windowsHide: false,
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => resolve({ exitCode: code ?? 1, stdout: '', stderr: '' }));
    });
  });
}

function buildRunCommandArgs(params: ZellijRunCommandParams): string[] {
  const args = ['-s', params.sessionName, 'run'];
  if (params.cwd) {
    args.push('--cwd', params.cwd);
  }
  args.push('--', ...params.command);
  return args;
}

async function requireSuccess(result: ZellijCommandResult, action: string): Promise<void> {
  if (result.exitCode !== 0) {
    throw new Error(`zellij ${action} failed: ${result.stderr || result.stdout}`);
  }
}

export async function attachCreateBackground(
  params: ZellijActionParams & Readonly<{ sessionName: string; cwd?: string; defaultShell?: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  const args = ['attach', '--create-background', params.sessionName];
  if (params.cwd || params.defaultShell) {
    args.push('options');
    if (params.cwd) {
      args.push('--default-cwd', params.cwd);
    }
    if (params.defaultShell) {
      args.push('--default-shell', params.defaultShell);
    }
  }
  return runZellij(
    params,
    args,
    params.timeoutMs !== undefined
      ? {
          cwd: params.cwd,
          timeoutMs: params.timeoutMs,
          action: 'attach',
          ...(process.platform === 'win32' ? { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true } : {}),
        }
      : {
          cwd: params.cwd,
          action: 'attach',
          ...(process.platform === 'win32' ? { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true } : {}),
        },
  );
}

export async function attachForeground(
  params: ZellijActionParams & Readonly<{ sessionName: string }>,
): Promise<ZellijCommandResult> {
  return runZellijForeground(params, ['attach', params.sessionName]);
}

export async function runCommand(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijCommandResult> {
  const args = buildRunCommandArgs(params);
  return runZellij(
    params,
    args,
    params.timeoutMs !== undefined
      ? { cwd: params.cwd, timeoutMs: params.timeoutMs, action: 'run' }
      : { cwd: params.cwd, action: 'run' },
  );
}

export async function startCommandDetached(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijDetachedCommandHandle> {
  const args = buildRunCommandArgs(params);
  const timeoutError = () => new ZellijActionTimeoutError('run');
  if (params.timeoutMs === 0) throw timeoutError();
  const deadline = createTerminalHostDeadline(params.timeoutMs);
  const releaseSlot = await acquireZellijActionSlot({
    socketDir: params.env.ZELLIJ_SOCKET_DIR,
    maxConcurrency: readZellijActionMaxConcurrency(),
    deadlineMs: deadline,
    timeoutError,
  });
  const remainingTimeoutMs = remainingTerminalHostDeadlineMs(deadline);
  if (remainingTimeoutMs === 0) {
    await releaseSlot();
    throw timeoutError();
  }
  return await new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    let released = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (timeout !== undefined) clearTimeout(timeout);
      void releaseSlot();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(params.zellijBinary, args, {
        cwd: params.cwd,
        env: buildZellijProcessEnv(params.env),
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    child.once('close', () => {
      closed = true;
      release();
    });
    child.once('error', (error) => {
      closed = true;
      release();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    const handle: ZellijDetachedCommandHandle = {
      ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
      dispose: () => {
        if (!closed && !child.killed) {
          child.kill();
        }
      },
    };
    queueMicrotask(() => {
      if (!settled) {
        settled = true;
        resolve(handle);
      }
    });
    timeout = remainingTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (!closed && !child.killed) child.kill();
          release();
        }, remainingTimeoutMs);
    timeout?.unref?.();
  });
}

export async function writeBytesChunked(params: ZellijPaneActionParams & Readonly<{
  text: string;
  chunkSize?: number;
  timeoutMs?: number;
}>): Promise<void> {
  const chunkSize = params.chunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE;
  const deadline = createTerminalHostDeadline(params.timeoutMs);
  for (const chunk of splitBufferByBytes(Buffer.from(params.text, 'utf8'), chunkSize)) {
    const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
    if (timeoutMs === 0) throw new ZellijActionTimeoutError('write');
    await requireSuccess(
      await runZellij(
        params,
        ['action', 'write', '--pane-id', params.paneId, ...[...chunk].map(String)],
        timeoutMs !== undefined ? { timeoutMs, action: 'write' } : { action: 'write' },
      ),
      'write',
    );
  }
}

export function resolveZellijActionPasteSafeBytes(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'darwin') return ZELLIJ_ACTION_PASTE_SAFE_BYTES.darwin;
  if (platform === 'linux') return ZELLIJ_ACTION_PASTE_SAFE_BYTES.linux;
  if (platform === 'win32') return ZELLIJ_ACTION_PASTE_SAFE_BYTES.win32;
  return ZELLIJ_ACTION_PASTE_SAFE_BYTES.fallback;
}

export async function pasteText(params: ZellijPaneActionParams & Readonly<{
  text: string;
  timeoutMs?: number;
}>): Promise<void> {
  if (params.timeoutMs === 0) throw new ZellijActionTimeoutError('paste');
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'paste', '--pane-id', params.paneId, params.text],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'paste' } : { action: 'paste' },
    ),
    'paste',
  );
}

export async function sendEnter(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void> {
  if (params.timeoutMs === 0) throw new ZellijActionTimeoutError('send-keys');
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'send-keys', '--pane-id', params.paneId, 'Enter'],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'send-keys' } : { action: 'send-keys' },
    ),
    'send-keys',
  );
}

export async function sendEscape(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void> {
  if (params.timeoutMs === 0) throw new ZellijActionTimeoutError('send-keys');
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'send-keys', '--pane-id', params.paneId, 'Esc'],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'send-keys' } : { action: 'send-keys' },
    ),
    'send-keys',
  );
}

export async function focusPane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'focus-pane-id', params.paneId],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'focus-pane-id' } : { action: 'focus-pane-id' },
    ),
    'focus-pane-id',
  );
}

export async function closePane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'close-pane', '--pane-id', params.paneId],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'close-pane' } : { action: 'close-pane' },
    ),
    'close-pane',
  );
}

export async function listSessions(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijCommandResult> {
  return runZellij(
    params,
    ['list-sessions'],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'list-sessions' } : { action: 'list-sessions' },
  );
}

export async function listPanes(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijPane[]> {
  const result = await runZellij(
    params,
    ['action', 'list-panes', '--json'],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'list-panes' } : { action: 'list-panes' },
  );
  await requireSuccess(result, 'list-panes');
  const parsed: unknown = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed.filter((pane): pane is ZellijPane => typeof pane === 'object' && pane !== null) : [];
}

export async function dumpScreen(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<string> {
  // `--ansi` preserves SGR styling: dim (SGR 2) text is the only honest discriminator between a
  // Claude Code empty-composer suggestion placeholder and a real typed draft (QA-B F6). Consumers
  // normalize/strip via the shared `controlCapture` owner, so plain-text behavior is unchanged.
  const timeoutOpts = params.timeoutMs !== undefined
    ? { timeoutMs: params.timeoutMs, action: 'dump-screen' }
    : { action: 'dump-screen' };
  const styled = await runZellij(params, ['action', 'dump-screen', '--ansi', '--pane-id', params.paneId], timeoutOpts);
  if (styled.exitCode === 0) return styled.stdout;
  // Older zellij builds reject `--ansi`; fall back to the plain dump (no styling info available).
  const plain = await runZellij(params, ['action', 'dump-screen', '--pane-id', params.paneId], timeoutOpts);
  await requireSuccess(plain, 'dump-screen');
  return plain.stdout;
}

export async function killSession(
  params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  return runZellij(
    params,
    ['kill-session', params.sessionName],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'kill-session' } : { action: 'kill-session' },
  );
}

export async function deleteSession(
  params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  return runZellij(
    params,
    ['delete-session', params.sessionName],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'delete-session' } : { action: 'delete-session' },
  );
}

export const defaultZellijActions: ZellijActions = {
  attachCreateBackground,
  runCommand,
  startCommandDetached,
  pasteText,
  writeBytesChunked,
  sendEnter,
  sendEscape,
  closePane,
  listSessions,
  listPanes,
  dumpScreen,
  killSession,
  deleteSession,
};

export const defaultZellijAttachActions: ZellijAttachActions = {
  attachForeground,
  focusPane,
};
