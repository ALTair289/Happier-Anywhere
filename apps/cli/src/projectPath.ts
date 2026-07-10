import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

function normalizePathLike(pathLike: string): string {
    return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

export function projectPathFromModuleUrl(moduleUrl: string): string {
    const modulePath = fileURLToPath(moduleUrl);
    const normalized = normalizePathLike(modulePath);
    for (const snapshotMarker of ['/.runner-snapshots/', '/dist/.runner-snapshots/']) {
        const snapshotIndex = normalized.lastIndexOf(snapshotMarker);
        if (snapshotIndex < 0) continue;
        const afterMarker = normalized.slice(snapshotIndex + snapshotMarker.length);
        const snapshotName = afterMarker.split('/')[0]?.trim();
        if (snapshotName) {
            return normalized.slice(0, snapshotIndex + snapshotMarker.length + snapshotName.length);
        }
    }

    for (const marker of ['/src/', '/dist/', '/package-dist/']) {
        const markerIndex = normalized.lastIndexOf(marker);
        if (markerIndex >= 0) {
            return normalized.slice(0, markerIndex);
        }
    }

    return resolve(dirname(modulePath), '..');
}

export function projectPath() {
    return projectPathFromModuleUrl(import.meta.url);
}
