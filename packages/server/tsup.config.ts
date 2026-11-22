import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  target: 'node26',
  clean: true,
  noExternal: ['@microrun/core', 'microrun'],
});
