import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// tests/node/*.test.mjs run under node:test instead (npm run test:node).
// The CLI in dist/cli imports the library by its package name, as Node resolves it.
export default defineConfig({
  resolve: { alias: { mritoolbox: fileURLToPath(new URL('./dist/index.js', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'] },
});
