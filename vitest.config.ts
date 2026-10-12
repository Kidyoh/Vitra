import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths({ root: './' })],
  test: {
    globals: true,
    // Playwright specs run via `pnpm --filter @vitra/docs test:e2e`, not vitest
    exclude: [...configDefaults.exclude, '**/e2e/**'],
  },
});