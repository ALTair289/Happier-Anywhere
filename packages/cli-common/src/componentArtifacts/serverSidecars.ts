import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { commandExists, execOrThrow, resolveYarnCommand, type RunCommand } from './commands.js';
import type { BinaryTarget } from './targets.js';
import {
  resolvePrismaSchemaEngineTarget,
  resolveRequestedServerDbProviders,
  resolveServerTargetRuntimeRequirements,
} from './serverRuntimePreflight.js';
import { resolveUiBuildEnvironment, type UiBuildProfile } from './uiBuildProfile.js';

const UI_WEB_EXPORT_MAX_WORKERS = '2';

declare const SERVER_ARTIFACT_BUILD_INVOCATION_BRAND: unique symbol;

export type ServerArtifactBuildInvocation = Readonly<{
  [SERVER_ARTIFACT_BUILD_INVOCATION_BRAND]: true;
}>;

type ServerArtifactBuildInvocationState = {
  uiGeneration: null | {
    repoRoot: string;
    inputFingerprint: string;
    generation: Promise<string>;
  };
};

const serverArtifactBuildInvocationStates = new WeakMap<object, ServerArtifactBuildInvocationState>();

export function createServerArtifactBuildInvocation(): ServerArtifactBuildInvocation {
  const invocation = Object.freeze({});
  serverArtifactBuildInvocationStates.set(invocation, { uiGeneration: null });
  return invocation as ServerArtifactBuildInvocation;
}

export {
  SUPPORTED_UI_DEPLOYMENT_RELEASE_RINGS,
  resolveUiBuildEnvironment,
} from './uiBuildProfile.js';
export type { UiBuildProfile } from './uiBuildProfile.js';

export type StageEntry = {
  sourcePath: string;
  targetPath: string;
};

export type ServerComponent = 'happier-server' | 'happier-server-light';
export { resolvePrismaSchemaEngineTarget, resolveRequestedServerDbProviders } from './serverRuntimePreflight.js';
export type { ServerDbProvider } from './serverRuntimePreflight.js';

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
};

async function ensureUiWebDist({
  repoRoot,
  env,
  runCommand,
  commandProbe,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runCommand: RunCommand;
  commandProbe: (cmd: string) => boolean;
}): Promise<string> {
  const uiDistPath = join(repoRoot, 'apps', 'ui', 'dist');
  await runCommand(process.execPath, ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'], {
    cwd: repoRoot,
    env,
  });

  const yarn = resolveYarnCommand({ commandProbe });
  await runCommand(
    yarn.cmd,
    [
      ...yarn.args,
      '--cwd', 'apps/ui',
      '-s', 'expo', 'export',
      '--platform', 'web',
      '--output-dir', 'dist',
      '--max-workers', UI_WEB_EXPORT_MAX_WORKERS,
    ],
    {
      cwd: repoRoot,
      env,
    },
  );

  const builtInfo = await stat(uiDistPath).catch(() => null);
  if (!builtInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing ui web dist directory: ${uiDistPath}`);
  }
  await runCommand(process.execPath, ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'], {
    cwd: repoRoot,
    env,
  });
  return uiDistPath;
}

function fingerprintUiGenerationInputs(
  env: NodeJS.ProcessEnv,
  uiBuildProfile: UiBuildProfile | undefined,
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(uiBuildProfile ?? { kind: 'legacy' }));
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    hash.update('\0');
    hash.update(name);
    hash.update('\0');
    hash.update(value === undefined ? '\0' : `1${value}`);
  }
  return hash.digest('hex');
}

async function ensureInvocationUiWebDist({
  repoRoot,
  env,
  uiBuildProfile,
  buildInvocation,
  runCommand,
  commandProbe,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  uiBuildProfile?: UiBuildProfile;
  buildInvocation?: ServerArtifactBuildInvocation;
  runCommand: RunCommand;
  commandProbe: (cmd: string) => boolean;
}): Promise<string> {
  const uiBuildEnv = await resolveUiBuildEnvironment({ repoRoot, env, uiBuildProfile });
  if (!buildInvocation) {
    return await ensureUiWebDist({ repoRoot, env: uiBuildEnv, runCommand, commandProbe });
  }

  const state = serverArtifactBuildInvocationStates.get(buildInvocation);
  if (!state) {
    throw new Error('[component-artifacts] invalid server artifact build invocation');
  }
  const inputFingerprint = fingerprintUiGenerationInputs(uiBuildEnv, uiBuildProfile);
  if (state.uiGeneration) {
    if (state.uiGeneration.repoRoot !== repoRoot
      || state.uiGeneration.inputFingerprint !== inputFingerprint) {
      throw new Error('[component-artifacts] server artifact build invocation UI inputs changed');
    }
    return await state.uiGeneration.generation;
  }

  const generation = ensureUiWebDist({ repoRoot, env: uiBuildEnv, runCommand, commandProbe });
  state.uiGeneration = { repoRoot, inputFingerprint, generation };
  return await generation;
}

function packageNameToNodeModulesPath(packageName: string): string {
  return join('node_modules', ...packageName.split('/'));
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[component-artifacts] invalid runtime package metadata');
  }
  return parsed as PackageJson;
}

function matchesPackageConstraint(values: string[] | undefined, targetValue: string): boolean {
  if (!values || values.length === 0) return true;
  const denied = values.some((value) => value === `!${targetValue}`);
  if (denied) return false;
  const allowedValues = values.filter((value) => !value.startsWith('!'));
  return allowedValues.length === 0 || allowedValues.includes(targetValue);
}

function packageSupportsTarget(packageJson: PackageJson, target: BinaryTarget): boolean {
  const npmOs = target.os === 'windows' ? 'win32' : target.os;
  return matchesPackageConstraint(packageJson.os, npmOs)
    && matchesPackageConstraint(packageJson.cpu, target.arch);
}

async function collectInstalledPackageSidecars({
  repoRoot,
  packageName,
  target,
  optional,
  visited,
}: {
  repoRoot: string;
  packageName: string;
  target: BinaryTarget;
  optional: boolean;
  visited: Set<string>;
}): Promise<StageEntry[]> {
  if (visited.has(packageName)) return [];
  const packageDir = join(repoRoot, packageNameToNodeModulesPath(packageName));
  const packageJsonPath = join(packageDir, 'package.json');
  const packageJsonInfo = await stat(packageJsonPath).catch(() => null);
  if (!packageJsonInfo?.isFile()) {
    if (optional) return [];
    throw new Error(`[component-artifacts] missing runtime package ${packageName}`);
  }

  const packageJson = await readPackageJson(packageJsonPath);
  if (!packageSupportsTarget(packageJson, target)) {
    if (optional) return [];
    throw new Error(`[component-artifacts] runtime package ${packageName} is incompatible with ${target.os}-${target.arch}`);
  }

  visited.add(packageName);
  const entries: StageEntry[] = [{
    sourcePath: packageDir,
    targetPath: packageNameToNodeModulesPath(packageName),
  }];

  for (const depName of Object.keys(packageJson.dependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      repoRoot,
      packageName: depName,
      target,
      optional: false,
      visited,
    }));
  }

  for (const depName of Object.keys(packageJson.optionalDependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      repoRoot,
      packageName: depName,
      target,
      optional: true,
      visited,
    }));
  }

  return entries;
}

export async function resolveServerBinarySidecarEntries({
  repoRoot,
  target,
  serverComponent = 'happier-server-light',
  buildDbProviders = String(process.env.HAPPIER_BUILD_DB_PROVIDERS ?? process.env.HAPPY_BUILD_DB_PROVIDERS ?? 'all').trim() || 'all',
  env = process.env,
  uiBuildProfile,
  buildInvocation,
  runCommand = execOrThrow,
  commandProbe = commandExists,
}: {
  repoRoot: string;
  target?: BinaryTarget;
  serverComponent?: ServerComponent;
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
  uiBuildProfile?: UiBuildProfile;
  buildInvocation?: ServerArtifactBuildInvocation;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
}): Promise<StageEntry[]> {
  const yarn = resolveYarnCommand({ commandProbe });
  const effectiveBuildDbProviders = serverComponent === 'happier-server' ? 'mysql' : buildDbProviders;
  await runCommand(
    yarn.cmd,
    [...yarn.args, '--cwd', 'apps/server', '-s', 'generate:providers'],
    {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_BUILD_DB_PROVIDERS: effectiveBuildDbProviders,
        HAPPY_BUILD_DB_PROVIDERS: effectiveBuildDbProviders,
      },
    },
  );

  if (serverComponent === 'happier-server') {
    if (!target) {
      throw new Error('[component-artifacts] a binary target is required for full-server migration artifacts');
    }
    const schemaEngine = resolvePrismaSchemaEngineTarget(target);
    await runCommand(
      process.execPath,
      [
        'apps/server/scripts/runtime/prepareFullRuntimeMigrationEngine.mjs',
        '--binary-target', schemaEngine.binaryTarget,
        '--out-dir', join(
          repoRoot,
          'apps',
          'server',
          'generated',
          'runtime-migration-engines',
          `${target.os}-${target.arch}`,
        ),
      ],
      { cwd: repoRoot, env },
    );
  }

  const dedupedProviders = resolveRequestedServerDbProviders(effectiveBuildDbProviders);

  const entries: StageEntry[] = [];
  for (const provider of dedupedProviders) {
    const sourcePath = join(repoRoot, 'apps', 'server', 'generated', `${provider}-client`);
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`[component-artifacts] missing generated Prisma directory for provider ${provider}: ${sourcePath}`);
    }
    entries.push({
      sourcePath,
      targetPath: join('generated', `${provider}-client`),
    });
  }

  if (dedupedProviders.includes('sqlite')) {
    const migrationsPath = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const migrationsInfo = await stat(migrationsPath).catch(() => null);
    if (!migrationsInfo?.isDirectory()) {
      throw new Error(`[component-artifacts] missing sqlite migrations directory: ${migrationsPath}`);
    }
    entries.push({
      sourcePath: migrationsPath,
      targetPath: join('prisma', 'sqlite', 'migrations'),
    });
  }

  if (serverComponent === 'happier-server') {
    const requiredFullServerEntries: StageEntry[] = [
      {
        sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'schema.prisma'),
        targetPath: join('prisma', 'schema.prisma'),
      },
      {
        sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'migrations'),
        targetPath: join('prisma', 'migrations'),
      },
      {
        sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'schema.prisma'),
        targetPath: join('prisma', 'mysql', 'schema.prisma'),
      },
      {
        sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'migrations'),
        targetPath: join('prisma', 'mysql', 'migrations'),
      },
    ];
    for (const entry of requiredFullServerEntries) {
      const info = await stat(entry.sourcePath).catch(() => null);
      if (!info) {
        throw new Error(`[component-artifacts] missing full-server migration input: ${entry.sourcePath}`);
      }
      entries.push(entry);
    }

    if (!target) {
      throw new Error('[component-artifacts] a binary target is required for full-server migration artifacts');
    }
    const targetKey = `${target.os}-${target.arch}`;
    const schemaEngineFileName = resolvePrismaSchemaEngineTarget(target).fileName;
    const schemaEnginePath = join(
      repoRoot,
      'apps',
      'server',
      'generated',
      'runtime-migration-engines',
      targetKey,
      schemaEngineFileName,
    );
    const schemaEngineInfo = await stat(schemaEnginePath).catch(() => null);
    if (!schemaEngineInfo?.isFile()) {
      throw new Error(`[component-artifacts] missing full-server Prisma schema engine for ${targetKey}: ${schemaEnginePath}`);
    }
    entries.push({
      sourcePath: schemaEnginePath,
      targetPath: join('runtime', target.os === 'windows' ? 'schema-engine.exe' : 'schema-engine'),
    });
    const schemaWasmPath = join(repoRoot, 'node_modules', 'prisma', 'build', 'prisma_schema_build_bg.wasm');
    const schemaWasmInfo = await stat(schemaWasmPath).catch(() => null);
    if (!schemaWasmInfo?.isFile()) {
      throw new Error(`[component-artifacts] missing full-server Prisma schema WASM: ${schemaWasmPath}`);
    }
    entries.push({
      sourcePath: schemaWasmPath,
      targetPath: join('runtime', 'prisma_schema_build_bg.wasm'),
    });
  }

  const uiDistPath = await ensureInvocationUiWebDist({
    repoRoot,
    env,
    uiBuildProfile,
    buildInvocation,
    runCommand,
    commandProbe,
  });
  entries.push({
    sourcePath: uiDistPath,
    targetPath: join('ui-web', 'current'),
  });

  const postgresClientPath = join(repoRoot, 'node_modules', '.prisma', 'client');
  const postgresClientInfo = await stat(postgresClientPath).catch(() => null);
  if (!postgresClientInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing generated postgres Prisma client directory: ${postgresClientPath}`);
  }
  entries.push({
    sourcePath: postgresClientPath,
    targetPath: join('node_modules', '.prisma', 'client'),
  });

  const prismaClientPackagePath = join(repoRoot, 'node_modules', '@prisma', 'client');
  const prismaClientPackageInfo = await stat(prismaClientPackagePath).catch(() => null);
  if (!prismaClientPackageInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing @prisma/client package directory: ${prismaClientPackagePath}`);
  }
  entries.push({
    sourcePath: prismaClientPackagePath,
    targetPath: join('node_modules', '@prisma', 'client'),
  });

  if (target) {
    const requirements = resolveServerTargetRuntimeRequirements(target);
    const requiredPackageNames = [...new Set([
      requirements.sharp.javascript.packageName,
      requirements.sharp.native.packageName,
      requirements.sharp.libvips.packageName,
    ])];
    const visited = new Set<string>();
    for (const packageName of requiredPackageNames) {
      entries.push(...await collectInstalledPackageSidecars({
        repoRoot,
        packageName,
        target,
        optional: false,
        visited,
      }));
    }
  }

  return entries;
}
