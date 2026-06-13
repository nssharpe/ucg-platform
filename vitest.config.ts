import { defineConfig } from 'vitest/config';

// Standalone test config — deliberately does NOT load the app's Vite plugins
// (React, PWA), so the suite stays fast and node-only. Tests target the pure
// logic modules (scoring engines, capability derivation); anything that needs
// the DOM/React would require a jsdom environment added later.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
