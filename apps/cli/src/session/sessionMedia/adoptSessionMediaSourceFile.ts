import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';

export async function adoptSessionMediaSourceFile(input: Readonly<{
    sourcePath: string;
    destinationPath: string;
}>): Promise<void> {
    try {
        await copyFile(input.sourcePath, input.destinationPath, constants.COPYFILE_FICLONE);
        return;
    } catch {
        // Reflink is opportunistic; fall through to other byte-preserving strategies.
    }

    // A hard link is not adoption: the provider can still mutate the durable file
    // through its source path. Preserve an independent byte snapshot instead.
    await copyFile(input.sourcePath, input.destinationPath);
}
