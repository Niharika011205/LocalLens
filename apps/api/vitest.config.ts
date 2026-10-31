import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Each test file starts its own in-memory MongoDB; the first run downloads the mongod binary.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
