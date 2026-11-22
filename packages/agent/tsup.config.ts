import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node26',
  clean: true,
  noExternal: ['@microrun/core'],
  banner: { js: '#!/usr/bin/env node' },
});
