import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // Must be set before any module imports to satisfy config.ts Zod validation
      VAULTWARDEN_ADMIN_TOKEN: 'test-admin-token-for-integration-tests-only',
      VAULT_INTERNAL_TOKEN: 'test-internal-token-min-32-characters-long',
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
    },
  },
});
