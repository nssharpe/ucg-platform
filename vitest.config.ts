import { defineConfig } from 'vitest/config';

// Standalone test config — deliberately does NOT load the app's Vite plugins
// (React, PWA), so the suite stays fast and node-only. Tests target the pure
// logic modules (scoring engines, capability derivation) plus component tests
// under tests/components/** (jsdom environment set per-file via the
// `// @vitest-environment jsdom` docblock pragma — environmentMatchGlobs is
// deprecated, so this is the supported way to mix environments).
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/components/setup.ts'],
    globals: false,
  },
});
