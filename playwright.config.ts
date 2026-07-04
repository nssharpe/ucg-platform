import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Load .env.staging.local ourselves (no dotenv dependency per project rules) so
// the test credentials (VITE_DEV_AUTH_*) are available to the specs via
// process.env. The same values also live in .env.local; staging is preferred
// here since these tests target the staging Supabase backend.
const dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file: string) {
  const full = path.resolve(dirname, file);
  if (!fs.existsSync(full)) return;
  for (const rawLine of fs.readFileSync(full, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile('.env.staging.local');
loadEnvFile('.env.local');

const PORT = 5178;
const BASE_URL = `http://localhost:${PORT}/ucg-platform/`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  expect: {
    // The app hydrates from Supabase after first paint — give assertions room.
    timeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --mode staging --port 5178 --strictPort',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
