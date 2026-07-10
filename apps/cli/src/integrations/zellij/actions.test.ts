import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

function mockChild(exitCode = 0, stdout = '', stderr = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
}

function mockHangingChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = vi.fn();
  return child;
}

async function expectTimedOutAndKilled(
  result: Promise<unknown>,
  child: ReturnType<typeof mockHangingChild>,
  advanceMs: number,
  expectedError: new (...args: never[]) => Error,
) {
  let rejection: unknown;
  const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const handled = result.catch((error: unknown) => {
    rejection = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(advanceMs);
    await Promise.resolve();
    expect(rejection).toBeUndefined();
    expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', 0);
    await handled;
    expect(rejection).toBeInstanceOf(expectedError);
  } finally {
    await result.catch(() => undefined);
    killProcessGroup.mockRestore();
  }
}

describe('zellij actions', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => mockChild());
    vi.useRealTimers();
  });

  it('pastes text with pane id as one zellij action without shell interpolation', async () => {
    const { pasteText } = await import('./actions');
    await pasteText({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      text: 'hello $(rm -rf /)\nsecond line',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'paste', '--pane-id', 'terminal_1', 'hello $(rm -rf /)\nsecond line'],
      expect.objectContaining({ shell: false }),
    );
    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.env).toMatchObject({ ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' });
  });

  it('resolves conservative zellij action-paste byte caps by host platform', async () => {
    const { resolveZellijActionPasteSafeBytes } = await import('./actions');

    expect(resolveZellijActionPasteSafeBytes('darwin')).toBe(300_000);
    expect(resolveZellijActionPasteSafeBytes('linux')).toBe(65_536);
    expect(resolveZellijActionPasteSafeBytes('win32')).toBe(16_384);
    expect(resolveZellijActionPasteSafeBytes('freebsd')).toBe(65_536);
  });

  it('runs raw-byte write chunks and Enter without shell interpolation', async () => {
    const { writeBytesChunked, sendEnter } = await import('./actions');
    await writeBytesChunked({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      text: 'hello $(rm -rf /)',
      chunkSize: 5,
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });
    await sendEnter({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      '/tools/zellij',
      ['action', 'write', '--pane-id', 'terminal_1', '104', '101', '108', '108', '111'],
      expect.objectContaining({ shell: false }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      '/tools/zellij',
      ['action', 'write', '--pane-id', 'terminal_1', '32', '36', '40', '114', '109'],
      expect.objectContaining({ shell: false }),
    );
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/tools/zellij',
      ['action', 'send-keys', '--pane-id', 'terminal_1', 'Enter'],
      expect.objectContaining({ shell: false }),
    );
    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.env).toMatchObject({ ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' });
  });

  it('dumps the screen with --ansi so dim placeholder styling survives (QA-B F6)', async () => {
    const { dumpScreen } = await import('./actions');
    spawnMock.mockImplementationOnce(() => mockChild(0, '\u001b[2mdim hint\u001b[22m\n'));
    const text = await dumpScreen({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/sock' },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'dump-screen', '--ansi', '--pane-id', 'terminal_1'],
      expect.objectContaining({ shell: false }),
    );
    expect(text).toBe('\u001b[2mdim hint\u001b[22m\n');
  });

  it('falls back to a plain dump-screen when the binary rejects --ansi', async () => {
    const { dumpScreen } = await import('./actions');
    spawnMock
      .mockImplementationOnce(() => mockChild(2, '', "error: Found argument '--ansi' which wasn't expected"))
      .mockImplementationOnce(() => mockChild(0, 'plain screen\n'));
    const text = await dumpScreen({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/sock' },
    });
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/tools/zellij',
      ['action', 'dump-screen', '--pane-id', 'terminal_1'],
      expect.objectContaining({ shell: false }),
    );
    expect(text).toBe('plain screen\n');
  });

  it('passes leading-dash bytes as numeric input instead of zellij options', async () => {
    const { writeBytesChunked } = await import('./actions');
    await writeBytesChunked({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      text: 'abcd-ef',
      chunkSize: 4,
      env: {},
    });

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      '/tools/zellij',
      ['action', 'write', '--pane-id', 'terminal_1', '45', '101', '102'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('chunks zellij writes by UTF-8 byte count', async () => {
    const { writeBytesChunked } = await import('./actions');
    await writeBytesChunked({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      text: 'a😊b',
      chunkSize: 4,
      env: {},
    });

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      '/tools/zellij',
      ['action', 'write', '--pane-id', 'terminal_1', '97', '240', '159', '152'],
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      '/tools/zellij',
      ['action', 'write', '--pane-id', 'terminal_1', '138', '98'],
      expect.any(Object),
    );
  });

  it('lists panes from zellij json output', async () => {
    spawnMock.mockImplementationOnce(() => mockChild(0, '[{"id":1,"is_plugin":false,"is_focused":true}]\n'));
    const { listPanes } = await import('./actions');

    await expect(listPanes({ zellijBinary: '/tools/zellij', env: {} })).resolves.toEqual([
      { id: 1, is_plugin: false, is_focused: true },
    ]);
  });

  it('globally caps concurrent zellij action client invocations', async () => {
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = [];
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    });

    try {
      const { listPanes } = await import('./actions');
      const first = listPanes({ zellijBinary: '/tools/zellij', env: {} });
      const second = listPanes({ zellijBinary: '/tools/zellij', env: {} });

      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      children[0]!.stdout.emit('data', Buffer.from('[]'));
      children[0]!.emit('close', 0);
      await first;
      await Promise.resolve();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      children[1]!.stdout.emit('data', Buffer.from('[]'));
      children[1]!.emit('close', 0);
      await second;
    } finally {
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
    }
  });

  it('shares the zellij action cap across independent module instances and jitters contention retries', async () => {
    const socketDir = await mkdtemp(join(tmpdir(), 'happier-zellij-limit-'));
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = [];
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    });

    try {
      vi.resetModules();
      const firstActions = await import('./actions');
      const first = firstActions.listPanes({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: socketDir },
      });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      vi.resetModules();
      const secondActions = await import('./actions');
      const second = secondActions.listPanes({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: socketDir },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(random).toHaveBeenCalled();

      children[0]!.stdout.emit('data', Buffer.from('[]'));
      children[0]!.emit('close', 0);
      await first;
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      children[1]!.stdout.emit('data', Buffer.from('[]'));
      children[1]!.emit('close', 0);
      await second;
    } finally {
      for (const child of children) child.emit('close', 0);
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      random.mockRestore();
      await rm(socketDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('includes limiter queue wait in the zellij action timeout deadline', async () => {
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const firstChild = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    firstChild.stdout = new EventEmitter();
    firstChild.stderr = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => firstChild)
      .mockImplementation(() => mockChild(0, '[]'));

    try {
      vi.resetModules();
      const { listPanes, ZellijActionTimeoutError } = await import('./actions');
      const first = listPanes({ zellijBinary: '/tools/zellij', env: {} });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      let queueError: unknown;
      const second = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 }).catch((error: unknown) => {
        queueError = error;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const errorBeforeRelease = queueError;

      firstChild.stdout.emit('data', Buffer.from('[]'));
      firstChild.emit('close', 0);
      await first;
      await second;

      expect(errorBeforeRelease).toBeInstanceOf(ZellijActionTimeoutError);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      firstChild.emit('close', 0);
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      vi.resetModules();
    }
  });

  it('counts detached command launchers in the same zellij action limit until they close', async () => {
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const detachedChild = mockHangingChild();
    spawnMock
      .mockImplementationOnce(() => detachedChild)
      .mockImplementation(() => mockChild(0, '[]'));

    try {
      vi.resetModules();
      const { listPanes, startCommandDetached } = await import('./actions');
      const detached = await startCommandDetached({
        zellijBinary: '/tools/zellij',
        env: {},
        sessionName: 'happy-claude',
        command: ['/managed/node', 'claude_local_launcher.cjs'],
        timeoutMs: 1_000,
      });
      const list = listPanes({ zellijBinary: '/tools/zellij', env: {} });

      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      detached.dispose();
      detachedChild.emit('close', 0);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      await list;
    } finally {
      detachedChild.emit('close', 0);
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      vi.resetModules();
    }
  });

  it('reclaims a shared zellij action slot whose owner process is gone', async () => {
    const socketDir = await mkdtemp(join(tmpdir(), 'happier-zellij-dead-owner-'));
    const slotDir = join(socketDir, '.happier-action-slots', 'slot-0');
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    await mkdir(slotDir, { recursive: true });
    await writeFile(join(slotDir, 'owner.json'), JSON.stringify({
      pid: 99_999_999,
      nonce: 'dead-owner',
      acquiredAtMs: 1,
    }));

    try {
      vi.resetModules();
      const { listPanes } = await import('./actions');
      await expect(listPanes({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: socketDir },
        timeoutMs: 250,
      })).resolves.toEqual([]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      await rm(socketDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('kills a hung list-panes action when its timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes, ZellijActionTimeoutError } = await import('./actions');

    const result = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 });
    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);
  });

  it('signals the zellij action process group when a timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes, ZellijActionTimeoutError } = await import('./actions');
    const result = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 });

    try {
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
      expect(options).toEqual(expect.objectContaining({ detached: true, shell: false }));
      expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      child.emit('close', 0);
      await expect(result).rejects.toBeInstanceOf(ZellijActionTimeoutError);
    } finally {
      child.emit('close', 0);
      await result.catch(() => undefined);
      killProcessGroup.mockRestore();
    }
  });

  it('kills a hung background attach action when its timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { attachCreateBackground, ZellijActionTimeoutError } = await import('./actions');

    const result = attachCreateBackground({
      zellijBinary: '/tools/zellij',
      env: {},
      sessionName: 'happy-claude',
      timeoutMs: 25,
    } as Parameters<typeof attachCreateBackground>[0] & { timeoutMs: number });
    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);
  });

  it('kills a hung run action when its timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { runCommand, ZellijActionTimeoutError } = await import('./actions');

    const result = runCommand({
      zellijBinary: '/tools/zellij',
      env: {},
      sessionName: 'happy-claude',
      command: ['/managed/node', 'claude_local_launcher.cjs'],
      timeoutMs: 25,
    } as Parameters<typeof runCommand>[0] & { timeoutMs: number });
    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);
  });

  it('kills a hung kill-session action when its timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { killSession, ZellijActionTimeoutError } = await import('./actions');

    const result = killSession({
      zellijBinary: '/tools/zellij',
      env: {},
      sessionName: 'happy-claude',
      timeoutMs: 25,
    } as Parameters<typeof killSession>[0] & { timeoutMs: number });
    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);
  });

  it('rejects after a bounded kill grace when a timed-out action does not close', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes, ZellijActionTimeoutError } = await import('./actions');

    let rejection: unknown;
    const result = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 });
    result.catch((error: unknown) => {
      rejection = error;
    });

    try {
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(rejection).toBeUndefined();

      await vi.advanceTimersByTimeAsync(249);
      await Promise.resolve();
      expect(rejection).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(rejection).toBeInstanceOf(ZellijActionTimeoutError);
      await result.catch(() => undefined);
    } finally {
      killProcessGroup.mockRestore();
    }
  });

  it('creates background sessions with explicit cwd and default shell options', async () => {
    const { attachCreateBackground } = await import('./actions');

    await attachCreateBackground({
      zellijBinary: '/tools/zellij',
      env: {},
      sessionName: 'happy-claude',
      cwd: '/workspace',
      defaultShell: 'cmd.exe',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      [
        'attach',
        '--create-background',
        'happy-claude',
        'options',
        '--default-cwd',
        '/workspace',
        '--default-shell',
        'cmd.exe',
      ],
      expect.objectContaining({ cwd: '/workspace', shell: false }),
    );
  });

  it('inherits stdin for Windows background session creation while suppressing bootstrap output', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('process.platform descriptor unavailable');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
      const { attachCreateBackground } = await import('./actions');

      await attachCreateBackground({
        zellijBinary: 'C:\\Tools\\zellij.exe',
        env: { ZELLIJ_SOCKET_DIR: 'C:\\Temp\\zellij' },
        sessionName: 'happy-claude',
        defaultShell: 'cmd.exe',
      });
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Tools\\zellij.exe',
      [
        'attach',
        '--create-background',
        'happy-claude',
        'options',
        '--default-shell',
        'cmd.exe',
      ],
      expect.objectContaining({
        shell: false,
        stdio: ['inherit', 'ignore', 'ignore'],
        windowsHide: true,
      }),
    );
  });

  it('foreground-attaches to an existing zellij session with inherited stdio', async () => {
    const actions = await import('./actions') as typeof import('./actions') & {
      attachForeground?: (params: {
        zellijBinary: string;
        env: Record<string, string>;
        sessionName: string;
      }) => Promise<unknown>;
    };
    expect(typeof actions.attachForeground).toBe('function');

    await actions.attachForeground?.({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
      sessionName: 'happy-claude',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['attach', 'happy-claude'],
      expect.objectContaining({
        shell: false,
        stdio: 'inherit',
      }),
    );
  });

  it('focuses a zellij pane by id before foreground attach', async () => {
    const actions = await import('./actions') as typeof import('./actions') & {
      focusPane?: (params: {
        zellijBinary: string;
        env: Record<string, string>;
        paneId: string;
      }) => Promise<unknown>;
    };
    expect(typeof actions.focusPane).toBe('function');

    await actions.focusPane?.({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SESSION_NAME: 'happy-claude' },
      paneId: 'terminal_7',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'focus-pane-id', 'terminal_7'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('kills a hung focus-pane action when its timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { focusPane, ZellijActionTimeoutError } = await import('./actions');

    const result = focusPane({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SESSION_NAME: 'happy-claude' },
      paneId: 'terminal_7',
      timeoutMs: 25,
    });
    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);

  });

  it('closes a specific zellij pane by id without shell interpolation', async () => {
    const actions = await import('./actions') as typeof import('./actions') & {
      closePane?: (params: {
        zellijBinary: string;
        env: Record<string, string>;
        paneId: string;
      }) => Promise<unknown>;
    };
    expect(typeof actions.closePane).toBe('function');

    await actions.closePane?.({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SESSION_NAME: 'happy-claude' },
      paneId: 'terminal_1',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'close-pane', '--pane-id', 'terminal_1'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('kills a hung close-pane action when its timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { closePane, ZellijActionTimeoutError } = await import('./actions');

    const result = closePane({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SESSION_NAME: 'happy-claude' },
      paneId: 'terminal_1',
      timeoutMs: 25,
    });
    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);

  });

  it('sends Escape to a specific zellij pane for turn interruption', async () => {
    const actions = await import('./actions') as typeof import('./actions') & {
      sendEscape?: (params: {
        zellijBinary: string;
        env: Record<string, string>;
        paneId: string;
      }) => Promise<unknown>;
    };
    expect(typeof actions.sendEscape).toBe('function');

    await actions.sendEscape?.({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SESSION_NAME: 'happy-claude' },
      paneId: 'terminal_7',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'send-keys', '--pane-id', 'terminal_7', 'Esc'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('runs commands in the named background session without shell interpolation', async () => {
    const { runCommand } = await import('./actions');
    const previousHugeEnv = process.env.HUGE_UNRELATED_ZELLIJ_ENV;
    process.env.HUGE_UNRELATED_ZELLIJ_ENV = 'z'.repeat(80_000);

    try {
      await runCommand({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock', HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js' },
        sessionName: 'happy-claude',
        cwd: '/workspace',
        command: ['/managed/node', 'claude_local_launcher.cjs', '--model', 'sonnet'],
      });
    } finally {
      if (previousHugeEnv === undefined) {
        delete process.env.HUGE_UNRELATED_ZELLIJ_ENV;
      } else {
        process.env.HUGE_UNRELATED_ZELLIJ_ENV = previousHugeEnv;
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      [
        '-s',
        'happy-claude',
        'run',
        '--cwd',
        '/workspace',
        '--',
        '/managed/node',
        'claude_local_launcher.cjs',
        '--model',
        'sonnet',
      ],
      expect.objectContaining({
        cwd: '/workspace',
        env: expect.objectContaining({
          HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js',
          ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock',
        }),
        shell: false,
      }),
    );
    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.env?.HUGE_UNRELATED_ZELLIJ_ENV).toBeUndefined();
  });

  it('starts detached command launchers without inheriting stdio and kills only the launcher on dispose', async () => {
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const actions = await import('./actions') as typeof import('./actions') & {
      startCommandDetached?: (params: {
        zellijBinary: string;
        env: Record<string, string>;
        sessionName: string;
        cwd?: string;
        command: readonly string[];
      }) => Promise<{ pid?: number; dispose(): void }>;
    };
    expect(typeof actions.startCommandDetached).toBe('function');

    const handle = await actions.startCommandDetached?.({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock', HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js' },
      sessionName: 'happy-claude',
      cwd: '/workspace',
      command: ['/managed/node', 'claude_local_launcher.cjs', '--model', 'sonnet'],
    });

    expect(handle?.pid).toBe(12345);
    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      [
        '-s',
        'happy-claude',
        'run',
        '--cwd',
        '/workspace',
        '--',
        '/managed/node',
        'claude_local_launcher.cjs',
        '--model',
        'sonnet',
      ],
      expect.objectContaining({
        cwd: '/workspace',
        env: expect.objectContaining({
          HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js',
          ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock',
        }),
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      }),
    );

    handle?.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', 0);
  });

  it('preserves Windows Path casing for zellij host actions', async () => {
    const previousPath = process.env.PATH;
    const previousWindowsPath = process.env.Path;
    if (!originalPlatformDescriptor) {
      throw new Error('process.platform descriptor unavailable');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    delete process.env.PATH;
    process.env.Path = 'C:\\Windows\\System32;C:\\Tools';
    try {
      const { runCommand } = await import('./actions');
      await runCommand({
        zellijBinary: 'C:\\Tools\\zellij.exe',
        env: { ZELLIJ_SOCKET_DIR: 'C:\\Temp\\zellij' },
        sessionName: 'happy-claude',
        command: ['C:\\Managed\\node.exe', 'claude_local_launcher.cjs'],
      });
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousWindowsPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = previousWindowsPath;
      }
    }

    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.env?.Path).toBe('C:\\Windows\\System32;C:\\Tools');
    expect(options?.env?.PATH).toBeUndefined();
  });
});
