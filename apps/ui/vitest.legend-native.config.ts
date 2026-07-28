import { mergeConfig, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import integrationConfig from './vitest.integration.config';

export default mergeConfig(integrationConfig, defineConfig({
    resolve: {
        // Exercise the same @legendapp/list/react-native import used by Happier,
        // selecting the installed package's native export instead of its web default.
        alias: [
            {
                find: '@legendapp/list/react-native',
                replacement: resolve('./node_modules/@legendapp/list/react-native.mjs'),
            },
            {
                find: /^react-native$/,
                replacement: resolve('./sources/dev/reactNativeStub.ts'),
            },
            {
                find: /^react-native\//,
                replacement: resolve('./sources/dev/reactNativeInternalStub.ts'),
            },
        ],
    },
    test: {
        include: ['sources/**/*.native.real.integration.test.{ts,tsx}'],
        server: {
            deps: {
                inline: [/@legendapp\/list/],
            },
        },
    },
}));
