import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests and the client examples import the client from its sources, before it is built.
    alias: { '@hivemagnus/ardent-client': fileURLToPath(new URL('./client/src/index.ts', import.meta.url)) },
  },
});
