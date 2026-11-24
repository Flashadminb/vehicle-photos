import { mkdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Static assets dir must exist for wrangler config parsing.
mkdirSync('dist', { recursive: true });

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/worker/index.ts',
      wrangler: { configPath: './wrangler.jsonc', environment: 'demo' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          SETUP_TOKEN: 'test-setup-token',
          PASSWORD_ITERATIONS: '10000',
        },
      },
    })),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    setupFiles: ['./test/worker/apply-migrations.ts'],
    testTimeout: 30000,
  },
});
