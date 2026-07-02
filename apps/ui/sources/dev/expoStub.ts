// Vitest/node stub for the `expo` package.
// The real `expo` entrypoint loads bundler-specific runtime modules that don't exist in Vitest.

import {
    requireNativeModule,
    requireOptionalNativeModule,
} from './expoModulesCoreStub';

const expoStub = {
    requireNativeModule,
    requireOptionalNativeModule,
};

export {
    requireNativeModule,
    requireOptionalNativeModule,
};

export default expoStub;
