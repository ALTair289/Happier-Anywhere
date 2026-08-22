import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';
import { terminateDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { waitForOwnerDeathWatchdogQuiescence } from './testkit/core/owner_death_watchdog_fixture.mjs';
import { writeStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';

function stackPaths() {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = dirname(scriptsDir);
    const repoRoot = dirname(dirname(packageRoot));
    return {
        repoRoot,
        devScript: join(packageRoot, 'scripts', 'dev.mjs'),
        runScript: join(packageRoot, 'scripts', 'run.mjs'),
    };
}

function runNode(args, { cwd, env, timeoutMs = 30_000 }) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, args, {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(async () => {
            if (settled) return;
            settled = true;
            await terminateDetachedTestProcess(proc);
            reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, timeoutMs);
        proc.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        proc.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        proc.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        proc.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr });
        });
    });
}

async function createFakeMonorepo(rootDir) {
    await mkdir(join(rootDir, 'node_modules'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });

    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'fake-happier-root', private: true }) + '\n', 'utf-8');
    await writeStubHappierCliFiles(rootDir, {
        packageJsonContent: JSON.stringify({ name: 'fake-cli', private: true }) + '\n',
        distIndexScript: 'process.exit(0);\n',
        binHappierScript: 'process.exit(0);\n',
    });
    await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
        join(rootDir, 'apps', 'server', 'package.json'),
        JSON.stringify({ name: 'fake-server', private: true, scripts: { start: 'node server.mjs' } }) + '\n',
        'utf-8',
    );
}

function spawnOtherServerDaemon(cliHomeDir, env) {
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...env,
            HAPPIER_HOME_DIR: cliHomeDir,
        },
    });
}

async function stopOtherServerDaemon(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
}

async function removeFixtureAfterOwnerDeathWatchdog({
    tempRoot,
    storageDir,
    stackName,
    removePreseededRuntimeState = false,
}) {
    if (removePreseededRuntimeState) {
        await rm(join(storageDir, stackName, 'stack.runtime.json'), { force: true });
    }
    await waitForOwnerDeathWatchdogQuiescence({ storageDir, stackName, timeoutMs: 60_000 });
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function writeRunningDaemonState({ cliHomeDir, serverUrl, pid, env }) {
    const paths = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
    await mkdir(dirname(paths.serverScopedStatePath), { recursive: true });
    await writeFile(
        paths.serverScopedStatePath,
        JSON.stringify({ pid, httpPort: 4321, startTime: new Date().toISOString() }) + '\n',
        'utf-8',
    );
}

async function withHealthServer({ stackName, envPath, env }, fn) {
    const child = spawn(process.execPath, ['-e', `
        const { createServer } = require('node:http');
        const server = createServer((req, res) => {
            if (req.url === '/health') {
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
                return;
            }
            res.statusCode = 404;
            res.end('not found');
        });
        server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    `], {
        detached: true,
        env: {
            ...env,
            HAPPIER_STACK_STACK: stackName,
            HAPPIER_STACK_ENV_FILE: envPath,
            HAPPIER_STACK_PROCESS_KIND: 'server',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.ok(child.pid && child.stdout, 'expected health server process');
    let port;
    try {
      port = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('timed out waiting for health server port')), 10_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            output += chunk;
            const parsed = Number(output.split(/\r?\n/).find(Boolean));
            if (Number.isInteger(parsed) && parsed > 0) {
                clearTimeout(timer);
                resolve(parsed);
            }
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`health server exited early (code=${code}, signal=${signal})`));
        });
      });
    } catch (error) {
      await terminateDetachedTestProcess(child);
      throw error;
    }
    try {
        await fn({ port, pid: child.pid });
    } finally {
        await terminateDetachedTestProcess(child);
    }
}

async function createListenerOwnershipBoundary({ rootDir, pid, stackName, envPath }) {
    const binDir = join(rootDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'lsof'), '#!/bin/sh\nprintf "%s\\n" "$OWNED_LISTENER_PID"\n', 'utf8');
    await writeFile(join(binDir, 'ps'), `#!/bin/sh
case " $* " in
  *" eww -p "*)
    printf 'PID COMMAND\\n'
    printf '%s node HAPPIER_STACK_STACK=%s HAPPIER_STACK_ENV_FILE=%s HAPPIER_STACK_PROCESS_KIND=server\\n' \
      "$OWNED_LISTENER_PID" "$OWNED_STACK_NAME" "$OWNED_STACK_ENV_PATH"
    ;;
  *" -o pgid= "*) printf '%s\\n' "$OWNED_LISTENER_PID" ;;
  *) exec /bin/ps "$@" ;;
esac
`, 'utf8');
    await chmod(join(binDir, 'lsof'), 0o755);
    await chmod(join(binDir, 'ps'), 0o755);
    return {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OWNED_LISTENER_PID: String(pid),
        OWNED_STACK_NAME: stackName,
        OWNED_STACK_ENV_PATH: envPath,
    };
}

test('hstack dev ignores a running daemon from another server scope', async () => {
    const { repoRoot, devScript } = stackPaths();
    const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-dev-daemon-scope-'));
    const fakeRepo = join(tempRoot, 'repo');
    const storageDir = join(tempRoot, 'storage');
    const stackName = 'scope-dev';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const otherServerUrl = 'https://other.example.test';
    const currentServerUrl = 'https://current.example.test';
    const isolatedEnv = sanitizeStackTestRunnerEnv(process.env);
    const otherDaemon = spawnOtherServerDaemon(cliHomeDir, isolatedEnv);

    try {
        await createFakeMonorepo(fakeRepo);
        await writeRunningDaemonState({ cliHomeDir, serverUrl: otherServerUrl, pid: otherDaemon.pid, env: isolatedEnv });

        const result = await runNode(
            [devScript, '--no-server', `--server-url=${currentServerUrl}`, '--no-ui', '--no-watch'],
            {
                cwd: repoRoot,
                env: {
                    ...isolatedEnv,
                    CI: '1',
                    HAPPIER_STACK_REPO_DIR: fakeRepo,
                    HAPPIER_STACK_STORAGE_DIR: storageDir,
                    HAPPIER_STACK_STACK: stackName,
                    HAPPIER_STACK_CLI_BUILD: '0',
                },
            },
        );

        assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.doesNotMatch(result.stdout, /dev: already running/);
        assert.match(result.stderr, /daemon auth required/);
    } finally {
        await stopOtherServerDaemon(otherDaemon);
        await removeFixtureAfterOwnerDeathWatchdog({ tempRoot, storageDir, stackName });
    }
});

test('hstack start ignores a running daemon from another server scope', async () => {
    const { repoRoot, runScript } = stackPaths();
    const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-daemon-scope-'));
    const fakeRepo = join(tempRoot, 'repo');
    const storageDir = join(tempRoot, 'storage');
    const stackName = 'scope-start';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const otherServerUrl = 'http://127.0.0.1:59991';
    const isolatedEnv = sanitizeStackTestRunnerEnv(process.env);
    const otherDaemon = spawnOtherServerDaemon(cliHomeDir, isolatedEnv);

    try {
        await createFakeMonorepo(fakeRepo);
        await writeRunningDaemonState({ cliHomeDir, serverUrl: otherServerUrl, pid: otherDaemon.pid, env: isolatedEnv });

        const envPath = join(storageDir, stackName, 'env');
        await withHealthServer({ stackName, envPath, env: isolatedEnv }, async ({ port, pid }) => {
            await writeStackRuntimeStateFile(join(storageDir, stackName, 'stack.runtime.json'), {
                version: 1,
                stackName,
                ports: { server: port },
                processes: { serverPid: pid },
            });
            const ownershipEnv = await createListenerOwnershipBoundary({
                rootDir: join(tempRoot, 'ownership-boundary'),
                pid,
                stackName,
                envPath,
            });
            const result = await runNode([runScript, '--no-ui'], {
                cwd: repoRoot,
                env: {
                    ...isolatedEnv,
                    ...ownershipEnv,
                    CI: '1',
                    HAPPIER_STACK_REPO_DIR: fakeRepo,
                    HAPPIER_STACK_STORAGE_DIR: storageDir,
                    HAPPIER_STACK_STACK: stackName,
                    HAPPIER_STACK_CLI_BUILD: '0',
                    HAPPIER_STACK_SERVER_PORT: String(port),
                },
            });

            assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
            assert.doesNotMatch(result.stdout, /start: already running/);
            assert.match(result.stderr, /daemon auth required/);
        });
    } finally {
        await stopOtherServerDaemon(otherDaemon);
        await removeFixtureAfterOwnerDeathWatchdog({
            tempRoot,
            storageDir,
            stackName,
            removePreseededRuntimeState: true,
        });
    }
});
