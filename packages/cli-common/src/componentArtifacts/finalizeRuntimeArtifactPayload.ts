import { readdir, readlink, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

async function removePackageManagerBinDirectories(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.name === '.bin') {
      await rm(path, { recursive: true, force: true });
      return;
    }
    if (entry.isDirectory()) {
      await removePackageManagerBinDirectories(path);
    }
  }));
}

async function assertSymlinksStayWithinPayload(payloadDir: string, directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertSymlinksStayWithinPayload(payloadDir, path);
      return;
    }
    if (!entry.isSymbolicLink()) return;

    const target = await readlink(path);
    const resolvedTarget = resolve(dirname(path), target);
    const relativeTarget = relative(payloadDir, resolvedTarget);
    const escapesPayload = relativeTarget === '..'
      || relativeTarget.startsWith(`..${sep}`)
      || isAbsolute(relativeTarget);
    if (isAbsolute(target) || escapesPayload) {
      throw new Error(
        `[component-artifacts] runtime payload symlink escapes the artifact: ${relative(payloadDir, path)} -> ${target}`,
      );
    }
  }));
}

export async function finalizeRuntimeArtifactPayload(payloadDir: string): Promise<void> {
  await removePackageManagerBinDirectories(join(payloadDir, 'node_modules'));
  await assertSymlinksStayWithinPayload(payloadDir, payloadDir);
}
