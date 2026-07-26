import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('../../apps/cli/src'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'suites/contracts/**/*.test.ts',
      'suites/core-e2e/**/*.test.ts',
      'src/testkit/**/*.{test,spec}.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
    exclude: [...resolveVitestFeatureTestExcludeGlobs()],
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
});
