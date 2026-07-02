import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function stackPaths() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  return {
    repoRoot,
    runScript: join(packageRoot, 'scripts', 'run.mjs'),
  };
}

function runNode(args, { cwd, env, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr });
    });
  });
}

async function createFakeMonorepo(rootDir) {
  await mkdir(join(rootDir, 'node_modules'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });

  await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'fake-happier-root', private: true }) + '\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fake-cli', private: true }) + '\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
  await writeFile(
    join(rootDir, 'apps', 'server', 'package.json'),
    JSON.stringify({ name: 'fake-server', private: true, scripts: { start: 'node server.mjs' } }) + '\n',
    'utf-8',
  );
  await writeFile(join(rootDir, 'apps', 'cli', 'dist', 'index.mjs'), 'process.exit(0);\n', 'utf-8');
}

async function spawnStackOwnedHealthServer({ stackName, envPath }) {
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
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(String(addr.port) + '\\n');
    });
    setInterval(() => {}, 1e6);
  `], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  assert.ok(child.pid, 'expected stack-owned health server pid');
  child.unref();

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for health server port')), 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split(/\r?\n/).find(Boolean);
      const parsed = Number(line);
      if (Number.isInteger(parsed) && parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`health server exited before reporting port (code=${code}, signal=${signal})`));
    });
  });

  return { child, port };
}

test('hstack start preserves proxy runtime state when reusing an existing proxy-mode server', async () => {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-proxy-runtime-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'proxy-runtime-start';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  let proxyServer = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
        `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
        '',
      ].join('\n'),
      'utf-8',
    );

    proxyServer = await spawnStackOwnedHealthServer({ stackName, envPath });
    const port = proxyServer.port;
    const backendPort = port === 65535 ? port - 1 : port + 1;
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: { server: port, serverBackend: backendPort },
        processes: {
          proxyPid: proxyServer.child.pid,
          serverPid: 777777,
          serverBackendPid: 777777,
          serverDrainingPid: null,
        },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb', fallbackReason: null },
      }) + '\n',
      'utf-8',
    );

    const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SERVER_PORT: String(port),
      },
    });

    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /start: already running/);

    const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(runtime.processes.proxyPid, proxyServer.child.pid);
    assert.equal(runtime.processes.serverBackendPid, 777777);
    assert.equal(runtime.ports.serverBackend, backendPort);
    assert.deepEqual(runtime.serverProxy, {
      enabled: true,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
      fallbackReason: null,
    });
  } finally {
    if (proxyServer?.child?.pid) {
      try {
        process.kill(-proxyServer.child.pid, 'SIGTERM');
      } catch {
        // ignore cleanup races
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
