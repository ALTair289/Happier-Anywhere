import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTypeScriptCommandInvocation } from '../../../scripts/workspaces/typescriptCommand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);
function runTsc(tsconfigPath) {
  const invocation = resolveTypeScriptCommandInvocation({
    cwd: resolve(repoRoot, 'apps', 'server'),
    args: ['-p', tsconfigPath],
  });
  execFileSync(invocation.command, invocation.args, { stdio: 'inherit' });
}

// Build shared packages (dist/ is the runtime contract).
// Protocol must build first because agents consumes @happier-dev/protocol dist/types.
runTsc(resolve(repoRoot, 'packages', 'protocol', 'tsconfig.json'));
runTsc(resolve(repoRoot, 'packages', 'agents', 'tsconfig.json'));
// Server imports shared runtime helpers from cli-common (e.g. tailscale helpers).
runTsc(resolve(repoRoot, 'packages', 'cli-common', 'tsconfig.json'));

// Sanity check: ensure protocol dist entry exists.
const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
if (!existsSync(protocolDist)) {
  throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
}

// Sanity check: ensure cli-common dist entry exists for server runtime imports.
const cliCommonTailscaleDist = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'tailscale', 'index.js');
if (!existsSync(cliCommonTailscaleDist)) {
  throw new Error(`Expected @happier-dev/cli-common tailscale build output missing: ${cliCommonTailscaleDist}`);
}
