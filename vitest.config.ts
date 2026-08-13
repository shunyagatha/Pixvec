import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Rendering and quantisation are CPU-heavy; the defaults are too tight.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: 'default',
  },
});
