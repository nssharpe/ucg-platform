import { test, expect } from '@playwright/test';
import { suppressDevAutoLogin, signIn, requireEnv } from './helpers';

test('event listing and detail reflect closed registration', async ({ page }) => {
  await suppressDevAutoLogin(page);
  const email = requireEnv('VITE_DEV_AUTH_ATHLETE_EMAIL');
  const password = requireEnv('VITE_DEV_AUTH_ATHLETE_PASSWORD');
  await signIn(page, email, password);
  await expect(page.getByText('Dev Athlete')).toBeVisible();

  await page.goto('/ucg-platform/#/events');

  // The seeded event's dates (2026-07-10..12) have rolled into the past, so it
  // may live under either tab depending on today's date — check Upcoming
  // first, fall back to Past. (Broke 2026-07-13 when it left "Upcoming".)
  let eventLink = page.getByRole('link', { name: 'UCG Nationals 2026' });
  if (!(await eventLink.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Past' }).click();
    eventLink = page.getByRole('link', { name: 'UCG Nationals 2026' });
  }
  await expect(eventLink).toBeVisible();
  await eventLink.click();

  // Event detail page: heading + sessions table (Session/Date/Levels columns).
  await expect(page.getByRole('heading', { name: 'UCG Nationals 2026' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Session' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Date' })).toBeVisible();

  // Registration closed 2026-06-24, today is 2026-07-04 — Events.tsx renders
  // a warn-tone "Registration closed" badge (no self-register/register-club
  // buttons) once eventIsInPhase(event, 'reg-open') is false.
  await expect(page.getByText('Registration closed')).toBeVisible();
});
