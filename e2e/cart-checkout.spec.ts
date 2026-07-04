import { test, expect } from '@playwright/test';
import { suppressDevAutoLogin, signIn, requireEnv } from './helpers';

test('athlete cart shows seeded items and starts Stripe checkout', async ({ page }) => {
  await suppressDevAutoLogin(page);
  const email = requireEnv('VITE_DEV_AUTH_ATHLETE_EMAIL');
  const password = requireEnv('VITE_DEV_AUTH_ATHLETE_PASSWORD');
  await signIn(page, email, password);
  await expect(page.getByText('Dev Athlete')).toBeVisible();

  await page.goto('/ucg-platform/#/cart');

  await expect(page.getByText('UCG membership 2026–27 — Dev Athlete')).toBeVisible();
  await expect(page.getByText('Dev Test Meet t-shirt (Adult M)')).toBeVisible();
  // Cart.tsx renders the Total card at both the top and bottom of the page.
  await expect(page.getByText('Total: $60').first()).toBeVisible();

  await page.getByRole('button', { name: 'Check out everything →' }).first().click();

  // create-checkout-session is a live call to staging — allow generous time
  // for the Stripe Embedded Checkout iframe + server-priced summary to appear.
  await expect(page.getByText('Subtotal')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Service fee (card processing)')).toBeVisible();
  await expect(page.getByText('Total due')).toBeVisible();

  const stripeFrame = page.locator('iframe[src*="stripe"]');
  await expect(stripeFrame.first()).toBeVisible({ timeout: 20_000 });
});
