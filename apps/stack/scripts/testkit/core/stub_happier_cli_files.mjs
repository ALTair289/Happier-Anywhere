import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLI_DIST_INTEGRITY_PROBE_GUARD = [
  "if (process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE === 'daemon-command'",
  "  && process.argv[2] === 'daemon'",
  "  && process.argv[3] === '--help') process.exit(0);",
  '',
].join('\n');

function addCliDistIntegrityProbeGuard(script) {
  const source = String(script);
  if (!source.startsWith('#!')) return CLI_DIST_INTEGRITY_PROBE_GUARD + source;
  const firstLineEnd = source.indexOf('\n');
  if (firstLineEnd < 0) return `${source}\n${CLI_DIST_INTEGRITY_PROBE_GUARD}`;
  return source.slice(0, firstLineEnd + 1) + CLI_DIST_INTEGRITY_PROBE_GUARD + source.slice(firstLineEnd + 1);
}

export async function writeStubHappierCliFiles(
  monoRoot,
  {
    packageJsonContent,
    distIndexScript,
    srcIndexScript,
    binHappierScript,
    tsconfigContent,
  } = {},
) {
  const cliDir = join(monoRoot, 'apps', 'cli');

  if (typeof packageJsonContent !== 'undefined') {
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, 'package.json'), packageJsonContent, 'utf-8');
  }

  if (typeof distIndexScript !== 'undefined') {
    await mkdir(join(cliDir, 'dist'), { recursive: true });
    await writeFile(join(cliDir, 'dist', 'index.mjs'), addCliDistIntegrityProbeGuard(distIndexScript), 'utf-8');
  }

  if (typeof srcIndexScript !== 'undefined') {
    await mkdir(join(cliDir, 'src'), { recursive: true });
    await writeFile(join(cliDir, 'src', 'index.ts'), srcIndexScript, 'utf-8');
  }

  if (typeof binHappierScript !== 'undefined') {
    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'bin', 'happier.mjs'), binHappierScript, 'utf-8');
  }

  if (typeof tsconfigContent !== 'undefined') {
    await writeFile(join(cliDir, 'tsconfig.json'), tsconfigContent, 'utf-8');
  }

  if (typeof distIndexScript !== 'undefined') {
    await writeFile(
      join(cliDir, 'dist', '.build-manifest.json'),
      JSON.stringify({
        fingerprint: '0000000000000000',
        builtAt: '2026-07-09T00:00:00.000Z',
        fileCount: 1,
        toolVersion: '1',
      }) + '\n',
      'utf-8',
    );
  }

  return {
    cliDir,
    cliDistDir: join(cliDir, 'dist'),
    cliSrcDir: join(cliDir, 'src'),
    cliBinDir: join(cliDir, 'bin'),
  };
}
