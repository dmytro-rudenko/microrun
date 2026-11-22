import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/*.docker.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
