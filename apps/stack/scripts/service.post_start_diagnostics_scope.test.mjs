import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';

function runNode(args, { cwd, env, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

test('postStartDiagnostics reads the exact named-stack daemon lifecycle scope', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-service-post-start-scope-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const stackRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(stackRoot));
  const stackName = 'named-service-stack';
  const cliIdentity = 'account-b';
  const cliHomeDir = join(tempRoot, 'cli');
  const storageDir = join(tempRoot, 'stacks');
  const stackHomeDir = join(tempRoot, 'stack-home');
  const envPath = join(tempRoot, 'named-stack.env');
  const internalServerUrl = 'http://127.0.0.1:43127';
  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_HOME_DIR: stackHomeDir,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_CLI_IDENTITY: cliIdentity,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_SERVER_PORT: '43127',
    HAPPIER_ACTIVE_SERVER_ID: 'named-endpoint-profile',
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_ambient__id_default',
  };
  await mkdir(stackHomeDir, { recursive: true });
  await writeFile(envPath, [
    `HAPPIER_STACK_STORAGE_DIR=${storageDir}`,
    `HAPPIER_STACK_STACK=${stackName}`,
    `HAPPIER_STACK_CLI_IDENTITY=${cliIdentity}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
    'HAPPIER_STACK_SERVER_PORT=43127',
    'HAPPIER_ACTIVE_SERVER_ID=named-endpoint-profile',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=stack_ambient__id_default',
    '',
  ].join('\n'));
  const exactEnv = applyStackDaemonLifecycleScopeEnv({
    env: baseEnv,
    stackName,
    cliIdentity,
  });
  const { serverScopedStatePath } = resolveStackDaemonStatePaths({
    cliHomeDir,
    serverUrl: internalServerUrl,
    env: exactEnv,
  });
  await mkdir(dirname(serverScopedStatePath), { recursive: true });
  await writeFile(serverScopedStatePath, JSON.stringify({ pid: process.pid, httpPort: 43127 }) + '\n');

  const serviceUrl = new URL('./service.mjs', import.meta.url).href;
  const result = await runNode([
    '--input-type=module',
    '-e',
    `const { postStartDiagnostics } = await import(${JSON.stringify(serviceUrl)}); await postStartDiagnostics();`,
  ], { cwd: repoRoot, env: baseEnv });

  assert.equal(result.code, 0, `expected diagnostics to complete\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /running.*pid=/s, `expected named-stack daemon running result\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /auth required/i);
});
