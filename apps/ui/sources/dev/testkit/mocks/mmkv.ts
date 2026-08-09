/**
 * Testkit surface for the MMKV storage boundary.
 *
 * `react-native-mmkv` is stubbed globally for every Vitest file — once through the
 * `vitest.config.ts` resolve alias and once through `vi.mock(...)` in `sources/dev/vitestSetup.ts`,
 * both pointing at `sources/dev/reactNativeMmkvStub.ts`. That stub is the single owner of the
 * boundary and is reset before every test.
 *
 * Top-level `sync.*` orchestrator tests use that shared boundary and must not redeclare
 * `vi.mock('react-native-mmkv', ...)`: a local mock silently replaces the owner with a narrower
 * surface, and any production code that later starts calling an unimplemented method (e.g.
 * `getAllKeys`) fails only in the files carrying the local copy. Narrow domain tests may still own
 * purpose-built storage fixtures when storage behavior is the contract under test. Import the
 * helpers below when a shared-boundary test needs to inspect or clear persisted bytes.
 */
export {
    readReactNativeMmkvStubEntries,
    readReactNativeMmkvStubValues,
    resetReactNativeMmkvStub,
} from '../../reactNativeMmkvStub';
