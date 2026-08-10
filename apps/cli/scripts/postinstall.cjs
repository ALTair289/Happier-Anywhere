'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function requireRegularScript(scriptPath, label, lstatSync) {
  let metadata;
  try {
    metadata = lstatSync(scriptPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`[postinstall] required ${label} is missing: ${scriptPath}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`[postinstall] required ${label} must be a regular non-symlink file: ${scriptPath}`);
  }
}

function requireSuccessfulChild(result, label) {
  if (result.error) {
    throw new Error(`[postinstall] failed to start ${label}: ${result.error.message}`, { cause: result.error });
  }
  if (!Number.isInteger(result.status) || result.status !== 0) {
    throw new Error(`[postinstall] ${label} exited with status ${result.status ?? 'unknown'}`);
  }
}

function runCliPostinstall(options = {}) {
  const packageRoot = path.resolve(options.packageRoot ?? path.join(__dirname, '..'));
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const spawnSync = options.spawnSync ?? childProcess.spawnSync;
  const gatePath = path.resolve(packageRoot, '..', '..', 'scripts', 'postinstall', 'shouldRunPostinstall.cjs');

  let shouldRun;
  if (Object.hasOwn(options, 'gateDecision')) {
    shouldRun = options.gateDecision === true;
  } else if (existsSync(gatePath)) {
    requireRegularScript(gatePath, 'workspace postinstall gate', lstatSync);
    const gate = require(gatePath);
    if (!gate || typeof gate.shouldRunPostinstall !== 'function') {
      throw new Error('[postinstall] workspace postinstall gate has an invalid contract');
    }
    shouldRun = gate.shouldRunPostinstall({
      workspace: 'cli',
      scope: process.env.HAPPIER_INSTALL_SCOPE || '',
    }) === true;
  } else {
    // Published standalone packages do not include the monorepo gate and must run.
    shouldRun = true;
  }
  if (!shouldRun) return { skipped: true };

  const unpackPath = path.join(packageRoot, 'scripts', 'unpack-tools.cjs');
  requireRegularScript(unpackPath, 'postinstall consumer unpack-tools.cjs', lstatSync);
  requireSuccessfulChild(
    spawnSync(process.execPath, [unpackPath], { cwd: packageRoot, stdio: 'inherit' }),
    'unpack-tools.cjs',
  );

  const permissionsPath = path.join(packageRoot, 'scripts', 'postinstall', 'fix-node-pty-spawn-helper-permissions.cjs');
  if (existsSync(permissionsPath)) {
    requireRegularScript(permissionsPath, 'permissions helper', lstatSync);
    requireSuccessfulChild(
      spawnSync(process.execPath, [permissionsPath], { cwd: packageRoot, stdio: 'inherit' }),
      'permissions helper',
    );
  }
  return { skipped: false };
}

module.exports = { runCliPostinstall };

if (require.main === module) {
  try {
    runCliPostinstall();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
