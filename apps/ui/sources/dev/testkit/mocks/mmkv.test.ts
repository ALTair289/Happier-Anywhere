import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MMKV } from 'react-native-mmkv';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    readReactNativeMmkvStubEntries,
    readReactNativeMmkvStubValues,
    resetReactNativeMmkvStub,
} from './mmkv';

const SOURCES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SYNC_ORCHESTRATOR_TEST_DIR = path.join(SOURCES_ROOT, 'sync');
const INLINE_MMKV_MOCK = "vi.mock('react-native-mmkv'";

function listSyncOrchestratorTestFiles(): readonly string[] {
    return fs
        .readdirSync(SYNC_ORCHESTRATOR_TEST_DIR)
        .filter((entry) => entry.startsWith('sync.') && entry.endsWith('.test.ts'))
        .sort();
}

describe('MMKV testkit boundary', () => {
    beforeEach(() => {
        resetReactNativeMmkvStub();
    });

    it('serves the whole MMKV surface used by persistence through one shared in-memory store', () => {
        const storage = new MMKV();

        storage.set('alpha', 'one');
        storage.set('beta', 2);

        // A second instance must observe the first one's writes: production code constructs its own
        // MMKV per persistence module, and tests assert across those modules.
        const other = new MMKV();
        expect(other.getString('alpha')).toBe('one');
        expect(other.getNumber('beta')).toBe(2);
        expect([...other.getAllKeys()].sort()).toEqual(['alpha', 'beta']);

        expect(readReactNativeMmkvStubValues()).toEqual(['one', 2]);
        expect(readReactNativeMmkvStubEntries()).toEqual([
            ['alpha', 'one'],
            ['beta', 2],
        ]);

        other.delete('alpha');
        expect(storage.getString('alpha')).toBeUndefined();
        expect(storage.getAllKeys()).toEqual(['beta']);

        storage.clearAll();
        expect(storage.getAllKeys()).toEqual([]);
        expect(readReactNativeMmkvStubValues()).toEqual([]);
    });

    it('is the only MMKV mock in the sync orchestrator suite', () => {
        // Local `vi.mock('react-native-mmkv', ...)` copies shadow the shared stub with a narrower
        // surface. Nine failures in this suite came from exactly that: production persistence began
        // calling `getAllKeys`, which the copies never implemented.
        const filesWithInlineMock = listSyncOrchestratorTestFiles().filter((file) =>
            fs.readFileSync(path.join(SYNC_ORCHESTRATOR_TEST_DIR, file), 'utf8').includes(INLINE_MMKV_MOCK),
        );

        expect(filesWithInlineMock).toEqual([]);
    });
});
