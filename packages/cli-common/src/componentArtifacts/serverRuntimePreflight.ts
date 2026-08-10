import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SERVER_BINARY_TARGETS, type BinaryTarget } from './targets.js';

export type ServerDbProvider = 'sqlite' | 'mysql';

export type ServerTargetRuntimeRequirements = {
  target: string;
  sharp: {
    javascript: { packageName: 'sharp'; version: '0.34.5' };
    native: { packageName: string; version: '0.34.5' };
    libvips: {
      packageName: string;
      version: '0.34.5' | '1.2.4';
      delivery: 'separate-package' | 'embedded-in-native-package';
    };
  };
  prisma: {
    queryEngineFileName: string;
    schemaEngineBinaryTarget: string;
    schemaEngineFileName: string;
  };
};

export type ServerArtifactRuntimeDependencyFailure =
  | {
      dependency: 'sharp-javascript' | 'sharp-native' | 'sharp-libvips';
      packageName: string;
      expectedVersion: string;
      reason: 'missing-package' | 'invalid-package-metadata' | 'version-mismatch' | 'target-incompatible';
    }
  | {
      dependency: 'prisma-postgres-query-engine' | 'prisma-sqlite-query-engine' | 'prisma-mysql-query-engine';
      engineFileName: string;
      reason: 'missing-engine';
    };

export type ServerArtifactRuntimeTargetReport = {
  target: string;
  failures: ServerArtifactRuntimeDependencyFailure[];
};

export type ServerArtifactRuntimeDependenciesReadyReport = {
  status: 'READY';
  code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_READY';
  targets: ServerArtifactRuntimeTargetReport[];
};

export type ServerArtifactRuntimeDependenciesBlockedReport = {
  status: 'BLOCKED';
  code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_UNAVAILABLE';
  targets: ServerArtifactRuntimeTargetReport[];
};

export type ServerArtifactRuntimeDependenciesReport =
  | ServerArtifactRuntimeDependenciesReadyReport
  | ServerArtifactRuntimeDependenciesBlockedReport;

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
  os?: unknown;
  cpu?: unknown;
};

type SharpPackageRequirement = {
  dependency: 'sharp-javascript' | 'sharp-native' | 'sharp-libvips';
  packageName: string;
  expectedVersion: string;
};

function targetKey(target: BinaryTarget): string {
  return `${target.os}-${target.arch}`;
}
function assertCanonicalServerTarget(target: BinaryTarget): void {
  const matchesCanonicalTarget = SERVER_BINARY_TARGETS.some((candidate) => (
    candidate.bunTarget === target.bunTarget
      && candidate.os === target.os
      && candidate.arch === target.arch
      && candidate.exeExt === target.exeExt
  ));
  if (!matchesCanonicalTarget) {
    throw new Error(`[component-artifacts] unsupported server binary target: ${targetKey(target)}`);
  }
}

function resolvePrismaQueryEngineFileName(target: BinaryTarget): string {
  const key = targetKey(target);
  switch (key) {
    case 'linux-x64':
      return 'libquery_engine-debian-openssl-3.0.x.so.node';
    case 'linux-arm64':
      return 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
    case 'darwin-x64':
      return 'libquery_engine-darwin.dylib.node';
    case 'darwin-arm64':
      return 'libquery_engine-darwin-arm64.dylib.node';
    case 'windows-x64':
      return 'query_engine-windows.dll.node';
    default:
      throw new Error(`[component-artifacts] unsupported Prisma query engine target: ${key}`);
  }
}

export function resolvePrismaSchemaEngineTarget(target: BinaryTarget): { binaryTarget: string; fileName: string } {
  assertCanonicalServerTarget(target);
  const key = targetKey(target);
  switch (key) {
    case 'linux-x64':
      return { binaryTarget: 'debian-openssl-3.0.x', fileName: 'schema-engine-debian-openssl-3.0.x' };
    case 'linux-arm64':
      return { binaryTarget: 'linux-arm64-openssl-3.0.x', fileName: 'schema-engine-linux-arm64-openssl-3.0.x' };
    case 'darwin-x64':
      return { binaryTarget: 'darwin', fileName: 'schema-engine-darwin' };
    case 'darwin-arm64':
      return { binaryTarget: 'darwin-arm64', fileName: 'schema-engine-darwin-arm64' };
    case 'windows-x64':
      return { binaryTarget: 'windows', fileName: 'schema-engine-windows.exe' };
    default:
      throw new Error(`[component-artifacts] unsupported Prisma schema engine target: ${key}`);
  }
}

export function resolvePrismaQueryEngineFileNameForTarget(target: BinaryTarget): string {
  assertCanonicalServerTarget(target);
  return resolvePrismaQueryEngineFileName(target);
}

export function resolveRequestedServerDbProviders(buildDbProviders: string): ServerDbProvider[] {
  const normalized = String(buildDbProviders ?? '').trim().toLowerCase();
  const requestedValues = normalized === 'all'
    ? ['sqlite', 'mysql']
    : normalized.split(',').map((value) => value.trim()).filter(Boolean);
  if (requestedValues.length === 0
    || requestedValues.some((value) => value !== 'sqlite' && value !== 'mysql')) {
    throw new Error('[component-artifacts] unsupported server database provider selection');
  }
  const requestedProviders = requestedValues as ServerDbProvider[];
  return [...new Set(requestedProviders)];
}

export function resolveServerTargetRuntimeRequirements(target: BinaryTarget): ServerTargetRuntimeRequirements {
  assertCanonicalServerTarget(target);
  const npmPlatform = target.os === 'windows' ? 'win32' : target.os;
  const nativePackageName = `@img/sharp-${npmPlatform}-${target.arch}`;
  const schemaEngine = resolvePrismaSchemaEngineTarget(target);
  const windowsEmbeddedLibvips = target.os === 'windows';
  return {
    target: targetKey(target),
    sharp: {
      javascript: { packageName: 'sharp', version: '0.34.5' },
      native: { packageName: nativePackageName, version: '0.34.5' },
      libvips: windowsEmbeddedLibvips
        ? {
            packageName: nativePackageName,
            version: '0.34.5',
            delivery: 'embedded-in-native-package',
          }
        : {
            packageName: `@img/sharp-libvips-${npmPlatform}-${target.arch}`,
            version: '1.2.4',
            delivery: 'separate-package',
          },
    },
    prisma: {
      queryEngineFileName: resolvePrismaQueryEngineFileName(target),
      schemaEngineBinaryTarget: schemaEngine.binaryTarget,
      schemaEngineFileName: schemaEngine.fileName,
    },
  };
}

function matchesPackageConstraint(values: unknown, targetValue: string): boolean {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) return false;
  if (values.length === 0) return true;
  const stringValues = values as string[];
  if (stringValues.some((value) => value === `!${targetValue}`)) return false;
  const allowedValues = stringValues.filter((value) => !value.startsWith('!'));
  return allowedValues.length === 0 || allowedValues.includes(targetValue);
}

async function inspectSharpPackageRequirement({
  repoRoot,
  target,
  requirement,
}: {
  repoRoot: string;
  target: BinaryTarget;
  requirement: SharpPackageRequirement;
}): Promise<ServerArtifactRuntimeDependencyFailure | null> {
  const packageJsonPath = join(repoRoot, 'node_modules', ...requirement.packageName.split('/'), 'package.json');
  const packageJsonInfo = await stat(packageJsonPath).catch(() => null);
  if (!packageJsonInfo?.isFile()) {
    return { ...requirement, reason: 'missing-package' };
  }

  let packageMetadata: PackageMetadata;
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...requirement, reason: 'invalid-package-metadata' };
    }
    packageMetadata = parsed as PackageMetadata;
  } catch {
    return { ...requirement, reason: 'invalid-package-metadata' };
  }

  if (packageMetadata.name !== requirement.packageName) {
    return { ...requirement, reason: 'invalid-package-metadata' };
  }
  if (packageMetadata.version !== requirement.expectedVersion) {
    return { ...requirement, reason: 'version-mismatch' };
  }
  const npmPlatform = target.os === 'windows' ? 'win32' : target.os;
  if (!matchesPackageConstraint(packageMetadata.os, npmPlatform)
    || !matchesPackageConstraint(packageMetadata.cpu, target.arch)) {
    return { ...requirement, reason: 'target-incompatible' };
  }
  return null;
}

async function inspectPrismaEngine({
  path,
  dependency,
  engineFileName,
}: {
  path: string;
  dependency: 'prisma-postgres-query-engine' | 'prisma-sqlite-query-engine' | 'prisma-mysql-query-engine';
  engineFileName: string;
}): Promise<ServerArtifactRuntimeDependencyFailure | null> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? null : { dependency, engineFileName, reason: 'missing-engine' };
}

async function inspectTargetRuntimeDependencies({
  repoRoot,
  target,
  providers,
}: {
  repoRoot: string;
  target: BinaryTarget;
  providers: ServerDbProvider[];
}): Promise<ServerArtifactRuntimeTargetReport> {
  const requirements = resolveServerTargetRuntimeRequirements(target);
  const sharpRequirements: SharpPackageRequirement[] = [
    {
      dependency: 'sharp-javascript',
      packageName: requirements.sharp.javascript.packageName,
      expectedVersion: requirements.sharp.javascript.version,
    },
    {
      dependency: 'sharp-native',
      packageName: requirements.sharp.native.packageName,
      expectedVersion: requirements.sharp.native.version,
    },
    {
      dependency: 'sharp-libvips',
      packageName: requirements.sharp.libvips.packageName,
      expectedVersion: requirements.sharp.libvips.version,
    },
  ];
  const failures: ServerArtifactRuntimeDependencyFailure[] = [];
  for (const requirement of sharpRequirements) {
    const failure = await inspectSharpPackageRequirement({ repoRoot, target, requirement });
    if (failure) failures.push(failure);
  }

  const postgresFailure = await inspectPrismaEngine({
    path: join(repoRoot, 'node_modules', '.prisma', 'client', requirements.prisma.queryEngineFileName),
    dependency: 'prisma-postgres-query-engine',
    engineFileName: requirements.prisma.queryEngineFileName,
  });
  if (postgresFailure) failures.push(postgresFailure);

  for (const provider of providers) {
    const failure = await inspectPrismaEngine({
      path: join(repoRoot, 'apps', 'server', 'generated', `${provider}-client`, requirements.prisma.queryEngineFileName),
      dependency: `prisma-${provider}-query-engine`,
      engineFileName: requirements.prisma.queryEngineFileName,
    });
    if (failure) failures.push(failure);
  }

  return { target: requirements.target, failures };
}

export async function inspectServerArtifactRuntimeDependencies({
  repoRoot,
  targets,
  serverComponent = 'happier-server-light',
  buildDbProviders = 'all',
}: {
  repoRoot: string;
  targets: readonly BinaryTarget[];
  serverComponent?: 'happier-server' | 'happier-server-light';
  buildDbProviders?: string;
}): Promise<ServerArtifactRuntimeDependenciesReport> {
  if (targets.length === 0) {
    throw new Error('[component-artifacts] server runtime preflight requires at least one target');
  }
  const providers = resolveRequestedServerDbProviders(
    serverComponent === 'happier-server' ? 'mysql' : buildDbProviders,
  );
  const targetReports: ServerArtifactRuntimeTargetReport[] = [];
  for (const target of targets) {
    targetReports.push(await inspectTargetRuntimeDependencies({ repoRoot, target, providers }));
  }
  const blocked = targetReports.some((report) => report.failures.length > 0);
  return blocked
    ? {
        status: 'BLOCKED',
        code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_UNAVAILABLE',
        targets: targetReports.filter((report) => report.failures.length > 0),
      }
    : {
        status: 'READY',
        code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_READY',
        targets: targetReports,
      };
}

export class ServerArtifactRuntimeDependenciesBlockedError extends Error {
  readonly report: ServerArtifactRuntimeDependenciesBlockedReport;

  constructor(report: ServerArtifactRuntimeDependenciesBlockedReport) {
    super(JSON.stringify(report));
    this.name = 'ServerArtifactRuntimeDependenciesBlockedError';
    this.report = report;
  }
}

export async function assertServerArtifactRuntimeDependencies(
  options: Parameters<typeof inspectServerArtifactRuntimeDependencies>[0],
): Promise<ServerArtifactRuntimeDependenciesReadyReport> {
  const report = await inspectServerArtifactRuntimeDependencies(options);
  if (report.status === 'BLOCKED') {
    throw new ServerArtifactRuntimeDependenciesBlockedError(report);
  }
  return report;
}
