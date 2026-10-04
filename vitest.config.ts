import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    // Each integration file starts its own real CMS/SQLite instance. Bound the
    // aggregate load when several isolated worktrees are tested on one host.
    maxWorkers: 2,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: process.env.CI ? 'artifacts/unit/junit.xml' : undefined,
    coverage: { enabled: false },
  },
});
