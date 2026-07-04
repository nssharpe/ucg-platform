import type { Page } from '@playwright/test';

/**
 * dev-auth (src/lib/dev-auth.ts) auto-signs in a seeded user on every dev
 * boot. E2E specs want to exercise the REAL Gate sign-in form instead, so
 * every test context gets this init script: it sets the same loop-guard key
 * dev-auth checks (`ucg-dev-signed-out`) before any app code runs, which
 * skips the auto-login.
 */
export async function suppressDevAutoLogin(page: Page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('ucg-dev-signed-out', '1');
  });
}

/**
 * Drives the real Gate sign-in form (src/pages/Gate.tsx, AuthGate/sign-in
 * mode, which is the default `mode` state). The Gate only renders on
 * account-only routes (App.tsx `RequireAccount` — e.g. `/me`); the root path
 * is guest-browsable (Home.tsx) and does NOT show it. Selectors follow the
 * actual markup: EMAIL/PASSWORD are placeholder-only inputs (no <label>), and
 * the submit button's accessible name is "Sign in →".
 */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/ucg-platform/#/me');
  await page.getByPlaceholder('EMAIL').fill(email);
  await page.getByPlaceholder('PASSWORD').fill(password);
  await page.getByRole('button', { name: 'Sign in →' }).click();
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} — check .env.staging.local`);
  return v;
}
