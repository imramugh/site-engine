import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: process.env.CI ? 'artifacts/unit/junit.xml' : undefined,
    coverage: { enabled: false },
  },
});
