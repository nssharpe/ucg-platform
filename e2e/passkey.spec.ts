import { test, expect } from '@playwright/test';
import { suppressDevAutoLogin, signIn, requireEnv } from './helpers';

// Passkey sign-in, exercised end-to-end via Playwright's CDP virtual
// authenticator (a "platform authenticator" the browser will use in place of
// a real Face ID/Touch ID/Windows Hello device, so the WebAuthn ceremony
// completes headlessly).
//
// Best-effort / future insurance: staging's Supabase project may not have the
// Passkeys feature enabled, and even if it is, its configured RP ID is very
// likely prod's (nssharpe.github.io per docs/CLAUDE.md), not localhost — the
// browser refuses the ceremony ("SecurityError: invalid domain") unless the
// RP ID is a registrable suffix of the page's own origin
// (http://localhost:5178 in this E2E run). Either failure surfaces as a
// `role="alert"` error toast from the "Add a passkey" button (ProfilePasskeys.tsx)
// — on that, skip cleanly rather than fail, and say why.
test('passkey registration + sign-in (skips if staging Passkeys isn\'t enabled for this origin)', async ({ page, context }) => {
  await suppressDevAutoLogin(page);

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const email = requireEnv('VITE_DEV_AUTH_ATHLETE_EMAIL');
  const password = requireEnv('VITE_DEV_AUTH_ATHLETE_PASSWORD');
  await signIn(page, email, password);
  await expect(page.getByText('Dev Athlete')).toBeVisible();

  await page.goto('/ucg-platform/#/me');
  const addButton = page.getByRole('button', { name: /Add a passkey/ });
  await expect(addButton).toBeVisible();
  await addButton.click();

  // Race the success toast against the error toast — whichever the
  // ProfilePasskeys.tsx handler fires first tells us which path we're on.
  const toast = page.locator('.toast').first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  const toastText = (await toast.innerText()).trim();
  const toastRole = await toast.getAttribute('role');

  if (toastRole === 'alert') {
    test.skip(true, `staging Passkeys not enabled/configured for this origin (got: "${toastText}") — enable Passkeys + set RP ID/origins to include localhost in the staging Supabase dashboard to run this spec for real.`);
    return;
  }

  await expect(toast).toContainText('Passkey added');

  // Sign out, then sign back in with the passkey we just registered.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto('/ucg-platform/#/me');
  const passkeyButton = page.getByRole('button', { name: /Sign in with a passkey/ });
  await expect(passkeyButton).toBeVisible();
  await passkeyButton.click();

  await expect(page.getByText('Dev Athlete')).toBeVisible({ timeout: 15_000 });

  // Learn the real AAL behavior for a passkey-only sign-in (no TOTP enrolled
  // for the seeded dev athlete, so no step-up interstitial is expected here).
  const aal = await page.evaluate(async () => {
    // The app doesn't expose the Supabase client on window, so read the AAL
    // claim directly out of the JWT the SDK persists to localStorage.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        try {
          const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
          const token = raw?.access_token as string | undefined;
          if (token) {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return payload.aal as string | undefined;
          }
        } catch { /* ignore */ }
      }
    }
    return undefined;
  });
  console.log(`[passkey.spec] session aal claim after passkey sign-in: ${aal}`);

  // Clean up: remove the passkey we registered so staging state stays clean.
  await page.goto('/ucg-platform/#/me');
  const removeButton = page.getByRole('button', { name: 'Remove' }).first();
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  await page.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(page.getByText(/^Removed /)).toBeVisible();
});
