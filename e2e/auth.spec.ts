import { test, expect } from '@playwright/test';
import { suppressDevAutoLogin, signIn, requireEnv } from './helpers';

test.beforeEach(async ({ page }) => {
  await suppressDevAutoLogin(page);
});

test('unauthenticated visit to an account-only route shows the sign-in gate', async ({ page }) => {
  // The root path is guest-browsable (Home.tsx) and does not show the Gate —
  // only account-only routes like /me do (App.tsx RequireAccount).
  await page.goto('/ucg-platform/#/me');
  await expect(page.getByPlaceholder('EMAIL')).toBeVisible();
  await expect(page.getByPlaceholder('PASSWORD')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in →' })).toBeVisible();
});

test('signing in with athlete creds lands signed in', async ({ page }) => {
  const email = requireEnv('VITE_DEV_AUTH_ATHLETE_EMAIL');
  const password = requireEnv('VITE_DEV_AUTH_ATHLETE_PASSWORD');
  await signIn(page, email, password);
  await expect(page.getByText('Dev Athlete')).toBeVisible();
});

test('signing in with a nonexistent email surfaces the no-account message', async ({ page }) => {
  await signIn(page, `no-such-user-${Date.now()}@example.invalid`, 'whatever-password');
  await expect(page.getByText('No account exists for that email.')).toBeVisible();
});
