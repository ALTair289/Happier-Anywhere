import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function buildStubDistFingerprint(source) {
  return createHash('sha256')
    .update('index.mjs\0', 'utf-8')
    .update(String(Buffer.byteLength(String(source ?? ''))), 'utf-8')
    .update('\0', 'utf-8')
    .update(String(source ?? ''), 'utf-8')
    .digest('hex')
    .slice(0, 16);
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
    await writeFile(join(cliDir, 'dist', 'index.mjs'), distIndexScript, 'utf-8');
    await writeFile(
      join(cliDir, 'dist', '.build-manifest.json'),
      JSON.stringify({
        fingerprint: buildStubDistFingerprint(distIndexScript),
        builtAt: '2026-07-09T00:00:00.000Z',
        fileCount: 1,
        toolVersion: '1',
      }) + '\n',
      'utf-8',
    );
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

  return {
    cliDir,
    cliDistDir: join(cliDir, 'dist'),
    cliSrcDir: join(cliDir, 'src'),
    cliBinDir: join(cliDir, 'bin'),
  };
}
