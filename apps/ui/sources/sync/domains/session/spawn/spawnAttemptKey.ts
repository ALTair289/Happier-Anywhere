import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

type SpawnAttemptKeyOptions = Readonly<{
    machineId: string;
    serverId?: string | null;
    directory: string;
}>;

export function createSpawnAttemptKeyForFreshSpawnOptions<T extends SpawnAttemptKeyOptions>(
    options: T,
    machineHomeDir: string,
): string {
    const directory = normalizeFileSystemPath(resolveAbsolutePath(options.directory.trim(), machineHomeDir));
    if (!directory) {
        throw new Error('Spawn attempt directory identity is unavailable');
    }
    return `machine.spawn_new:${JSON.stringify({
        machineId: options.machineId.trim(),
        serverId: options.serverId?.trim() ?? null,
        directory,
    })}`;
}
