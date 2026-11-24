import { defineConfig } from 'vitest/config';

// tests/node/*.test.mjs run under node:test instead (npm run test:node).
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
