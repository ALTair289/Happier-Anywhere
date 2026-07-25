import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';
import { terminateDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';

function runNode(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function ensureMinimalMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

async function spawnStackOwnedHealthServer({ stackName, envPath, env }) {
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
  assert.ok(child.pid && child.stdout, 'expected stack-owned health server process');
  try {
    const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for stack-owned health server')), 10_000);
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
      reject(new Error(`stack-owned health server exited early (code=${code}, signal=${signal})`));
    });
    });
    return { child, port };
  } catch (error) {
    await terminateDetachedTestProcess(child);
    throw error;
  }
}

async function stopChild(child) {
  await terminateDetachedTestProcess(child);
}

test('hstack stack auth <stack> login --print prefers pinned env port over stale runtime port', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-pinned-port-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    await ensureMinimalMonorepo({ monoRoot });

    const stackName = 'dev';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });

    const envPath = join(stackDir, 'env');
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        'HAPPIER_STACK_SERVER_PORT=4101',
        // Avoid external probes so --json stays hermetic.
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    // Simulate a stale runtime state with a different port recorded.
    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({ version: 1, ownerPid: 0, ports: { server: 4999 } }, null, 2) + '\n',
      'utf-8'
    );

    const env = {
      ...sanitizeStackTestRunnerEnv(process.env),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'auth', stackName, 'login', '--print', '--no-open', '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.internalServerUrl, 'http://127.0.0.1:4101');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack stack auth <stack> login --print uses last runtime port when stack env is ephemeral', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-ephemeral-port-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    await ensureMinimalMonorepo({ monoRoot });

    const stackName = 'dev';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });

    const envPath = join(stackDir, 'env');
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        // Intentionally omit HAPPIER_STACK_SERVER_PORT (ephemeral model).
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({ version: 1, ownerPid: 0, ports: { server: 4999 } }, null, 2) + '\n',
      'utf-8'
    );

    const env = {
      ...sanitizeStackTestRunnerEnv(process.env),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'auth', stackName, 'login', '--print', '--no-open', '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.internalServerUrl, 'http://127.0.0.1:4999');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack stack dev <stack> --json reuses recorded runtime port for ephemeral stacks', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-ephemeral-reuse-'));
  let ownedServer = null;
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    await ensureMinimalMonorepo({ monoRoot });

    const stackName = 'dev';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });

    const envPath = join(stackDir, 'env');
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        // Intentionally omit HAPPIER_STACK_SERVER_PORT (ephemeral model).
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    const isolatedEnv = sanitizeStackTestRunnerEnv(process.env);
    ownedServer = await spawnStackOwnedHealthServer({ stackName, envPath, env: isolatedEnv });
    const runtimePort = ownedServer.port;
    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 0,
        ports: { server: runtimePort },
        processes: { serverPid: ownedServer.child.pid },
      }, null, 2) + '\n',
      'utf-8'
    );

    const env = {
      ...isolatedEnv,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'dev', stackName, '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.serverPort, runtimePort);
  } finally {
    await stopChild(ownedServer?.child);
    await rm(tmp, { recursive: true, force: true });
  }
});
