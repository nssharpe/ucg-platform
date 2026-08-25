// D-09 (whats-next.md §3.5, UAT 2026-08-25): deployed updates must announce
// themselves. Before this, a new build sat in the service worker's "waiting"
// state indefinitely — a long-lived tab/PWA install never learned a deploy
// had happened until an unrelated full reload. On 2026-08-25 this cost the
// event owners a testing session: the live site was 3 builds ahead of what
// their installed PWA showed, with no way for them to know.
//
// registerType is 'prompt' in vite.config.ts specifically so the new worker
// never activates itself — this module is the ONLY place that decides when
// to activate the waiting worker, and it only does so on an explicit click.
import { registerSW } from 'virtual:pwa-register';
import { pushToast } from './toast-bus';
import { reportError } from './report-error';

/** How often a long-lived tab re-checks for a new deploy, on top of the
 *  visibilitychange check below. 60 min is deliberately coarse — this is a
 *  courtesy for tabs left open for hours/days, not a low-latency channel. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Floor between visibilitychange-triggered checks. `registration.update()`
 *  is a conditional-GET against sw.js (cheap), but alt-tabbing repeatedly
 *  shouldn't fire one every time regardless — this is a much shorter floor
 *  than focus-refresh.ts's REFRESH_THRESHOLD_MS (60s) on purpose: that module
 *  guards a real Supabase resync, this guards a single small HTTP request. */
const VISIBILITY_CHECK_MIN_GAP_MS = 5 * 60 * 1000;

/** Wire the "new version available" prompt + periodic update checks. Call
 *  exactly once at boot (main.tsx) — NOT from a React component render/effect,
 *  since this must run once for the app's lifetime, not once per mount. */
export function initPwaUpdatePrompt(): void {
  // Workbox re-fires its 'waiting' event (which drives onNeedRefresh, per
  // vite-plugin-pwa's client/build/register.js) for each new worker that
  // reaches the waiting state — so a tab left open across two deploys would
  // otherwise stack two identical sticky toasts. Only prompt once per page
  // load; the toast + waiting worker both survive until the member acts.
  let refreshPrompted = false;
  let lastVisibilityCheckMs = 0;

  const updateSW = registerSW({
    // No user-facing toast: "ready to work offline" firing on a member's
    // very first visit would be noise, not news, for an app most people use
    // online. Callback is still wired (rather than omitted) so a future need
    // for it — or just confirming precache completed — has a hook already in
    // place.
    onOfflineReady() {},
    onNeedRefresh() {
      if (refreshPrompted) return;
      refreshPrompted = true;
      // Sticky by default (toast-bus/ToastProvider never auto-dismiss) — a
      // deploy notice sitting unread for a while is fine; losing it isn't.
      pushToast('A new version is available.', {
        variant: 'info',
        action: {
          label: 'Refresh now',
          // updateSW() posts SKIP_WAITING to the waiting worker; that worker
          // calls self.skipWaiting() (confirmed in the generated sw.js — it's
          // the only unconditional trigger for it) and takes control, which
          // fires vite-plugin-pwa's own 'controlling' listener and reloads
          // this tab. The `true` argument is accepted for API compatibility
          // but ignored by the current version — the reload isn't driven by
          // it, so don't rely on the argument if this ever changes upstream.
          onClick: () => { void updateSW(true); },
        },
      });
    },
    onRegisteredSW(_swScriptUrl, registration) {
      if (!registration) return;
      // Hourly poll, so a tab that's never backgrounded still learns about a
      // deploy eventually.
      setInterval(() => { void registration.update(); }, UPDATE_CHECK_INTERVAL_MS);
      // Plus a (throttled) check whenever the tab/PWA comes back into view —
      // the common case (someone re-opens the app after it deployed) doesn't
      // need to wait up to an hour.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - lastVisibilityCheckMs < VISIBILITY_CHECK_MIN_GAP_MS) return;
        lastVisibilityCheckMs = now;
        void registration.update();
      });
    },
    onRegisterError(error) {
      reportError(error, 'pwa-register');
    },
  });
}
