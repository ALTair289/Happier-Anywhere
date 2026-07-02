import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const DEFAULT_PKGROLL_TIMEOUT_MS = 600_000;

function resolvePkgrollTimeoutMs(env, explicitTimeoutMs) {
  if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs)) {
    return Math.min(1_800_000, Math.max(60_000, Math.trunc(explicitTimeoutMs)));
  }
  const raw = String(env?.HAPPIER_CLI_PKGROLL_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_PKGROLL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PKGROLL_TIMEOUT_MS;
  return Math.min(1_800_000, Math.max(60_000, parsed));
}

function normalizePkgrollOutputDir(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'dist';
  if (raw.startsWith('-')) return 'dist';
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return 'dist';
  if (segments.includes('.') || segments.includes('..')) return 'dist';
  if (normalized.startsWith('/')) return 'dist';
  return segments.join('/');
}

function rewritePackageDistPath(value, outputDir = 'dist') {
  if (typeof value !== 'string') return value;
  const outputRoot = `./${normalizePkgrollOutputDir(outputDir)}`;
  if (value === './package-dist') return outputRoot;
  if (value.startsWith('./package-dist/')) {
    return `${outputRoot}/${value.slice('./package-dist/'.length)}`;
  }
  return value;
}

function rebasePackageEntrypointOutputPath(value, outputDir = 'dist') {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const outputRoot = normalizePkgrollOutputDir(outputDir);
  for (const sourceRoot of ['dist', 'package-dist']) {
    if (normalized === sourceRoot) {
      return outputRoot;
    }
    const prefix = `${sourceRoot}/`;
    if (normalized.startsWith(prefix)) {
      return `${outputRoot}/${normalized.slice(prefix.length)}`;
    }
  }
  return null;
}

function collectEntrypointOutputPaths(value, outputDir, out) {
  const outputPath = rebasePackageEntrypointOutputPath(value, outputDir);
  if (outputPath) {
    out.add(outputPath);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEntrypointOutputPaths(item, outputDir, out);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const entryValue of Object.values(value)) {
    collectEntrypointOutputPaths(entryValue, outputDir, out);
  }
}

export function collectPkgrollInputPaths(manifest, options = {}) {
  const outputDir = normalizePkgrollOutputDir(options.outputDir);
  const paths = new Set();
  for (const key of ['main', 'module', 'types', 'exports', 'imports']) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      collectEntrypointOutputPaths(manifest[key], outputDir, paths);
    }
  }
  return [...paths].sort();
}

export function preparePkgrollPackageManifest(value, options = {}) {
  const outputDir = normalizePkgrollOutputDir(options.outputDir);
  if (Array.isArray(value)) {
    return value.map((item) => preparePkgrollPackageManifest(item, { outputDir }));
  }
  if (!value || typeof value !== 'object') {
    return rewritePackageDistPath(value, outputDir);
  }

  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    // pkgroll emits warnings for `bin` entries that point outside the built output.
    // Since bin files are not part of pkgroll's bundling inputs, omit them from the
    // temporary manifest we hand to pkgroll (the original package.json is restored).
    if (key === 'bin') continue;
    if (key === 'files') {
      out[key] = entryValue;
      continue;
    }
    out[key] = preparePkgrollPackageManifest(entryValue, { outputDir });
  }
  return out;
}

export function resolvePkgrollCliPath() {
  return require.resolve('pkgroll/dist/cli.mjs');
}

export function runPkgrollBuild(options = {}) {
  const packageJsonPath = resolve(String(options.packageJsonPath ?? 'package.json'));
  const spawn = options.spawn ?? spawnSync;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const env = options.env ?? process.env;
  const timeoutMs = resolvePkgrollTimeoutMs(env, options.timeoutMs);
  const outputDir = normalizePkgrollOutputDir(options.outputDir ?? env?.HAPPIER_CLI_BUILD_OUTPUT_DIR);
  const original = readFileSync(packageJsonPath, 'utf8');
  const manifest = JSON.parse(original);
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();
  const inputPaths = collectPkgrollInputPaths(manifest, { outputDir });
  if (inputPaths.length === 0) {
    throw new Error('No package entrypoints found for pkgroll build');
  }

  const pkgrollArgs = [pkgrollCliPath, '--packagejson=false', '--srcdist', `src:${outputDir}`];
  for (const inputPath of inputPaths) {
    pkgrollArgs.push('--input', inputPath);
  }

  const result = spawn(nodeExecutable, pkgrollArgs, {
    cwd: dirname(packageJsonPath),
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`pkgroll exited with status ${result.status}`);
  }
  if (result.error) {
    const errorCode = typeof result.error?.code === 'string' ? result.error.code : '';
    if (errorCode === 'ETIMEDOUT') {
      throw new Error(`pkgroll timed out after ${timeoutMs}ms`);
    }
    throw result.error;
  }
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/runPkgrollBuild.mjs') || arg.endsWith('\\runPkgrollBuild.mjs');
})();

if (isEntrypoint) {
  runPkgrollBuild();
}
