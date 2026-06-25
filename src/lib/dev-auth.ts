// DEV-ONLY auto-login of a seeded Supabase test user.
//
// FIREWALL: this entire module is loaded ONLY via a dynamic `import('./dev-auth')`
// that sits behind an `if (import.meta.env.DEV)` guard in auth.ts. Vite replaces
// `import.meta.env.DEV` with the literal `false` in a production build, esbuild
// dead-code-eliminates the dead `if`, the dynamic import is dropped, and this
// module (with every `VITE_DEV_AUTH_*` literal it references) is never emitted
// into the production bundle. The guards below are belt-and-suspenders on top of
// that — they make the path a no-op even if it somehow ran.
//
// It performs a REAL `signInWithPassword`, so the existing
// onAuthStateChange → applySession → onAuthenticated/syncFromSupabase path runs
// exactly as a normal login: real JWT, RLS, Edge Functions, roles. Credentials
// come from gitignored `.env.local` vars (see .env.example). There is no fake
// `me` — an unauthenticated client runs as `anon` and RLS blocks everything.
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

type DevRole = 'athlete' | 'manager' | 'admin';
interface DevUser { role: DevRole; label: string; email: string; password: string }

// Static member access (NOT `import.meta.env[key]`) so Vite can statically
// inline each value — and so these literals only ever exist in this dev-only
// chunk. Missing vars are `undefined`; such users are filtered out below.
const RAW: { role: DevRole; label: string; email?: string; password?: string }[] = [
  { role: 'athlete', label: 'Athlete', email: import.meta.env.VITE_DEV_AUTH_ATHLETE_EMAIL, password: import.meta.env.VITE_DEV_AUTH_ATHLETE_PASSWORD },
  { role: 'manager', label: 'Club mgr', email: import.meta.env.VITE_DEV_AUTH_MANAGER_EMAIL, password: import.meta.env.VITE_DEV_AUTH_MANAGER_PASSWORD },
  { role: 'admin', label: 'Admin', email: import.meta.env.VITE_DEV_AUTH_ADMIN_EMAIL, password: import.meta.env.VITE_DEV_AUTH_ADMIN_PASSWORD },
];

const DEV_USERS: DevUser[] = RAW.filter(
  (u): u is DevUser => Boolean(u.email && u.password),
);

// Set by the Layout sign-out button (dev only) so a manual sign-out doesn't
// instantly auto-login again on the next boot/reload — lets the signed-out gate
// be tested. Cleared when a switcher button is clicked.
const SIGNED_OUT_KEY = 'ucg-dev-signed-out';
// Remembers which seeded role was last chosen, so reloads keep that user.
const ROLE_KEY = 'ucg-dev-role';

function pickUser(): DevUser {
  const saved = sessionStorage.getItem(ROLE_KEY);
  return DEV_USERS.find((u) => u.role === saved) ?? DEV_USERS[0];
}

async function signInAs(user: DevUser) {
  if (!supabase) return;
  sessionStorage.removeItem(SIGNED_OUT_KEY);
  sessionStorage.setItem(ROLE_KEY, user.role);
  renderSwitcher(user.role); // optimistic highlight
  const { error } = await supabase.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) {
    console.warn(`[dev-auth] sign-in as ${user.email} failed: ${error.message}`);
  }
}

/**
 * Entry point, called once from auth.ts's boot block behind `import.meta.env.DEV`.
 * Mounts the dev switcher and, if no one is signed in and the user hasn't
 * manually signed out, signs in the selected seeded user with a real password.
 */
export async function initDevAuth(bootSession: Promise<Session | null>) {
  if (!import.meta.env.DEV || !supabase || DEV_USERS.length === 0) return;
  mountSwitcher();
  const session = await bootSession;
  if (session) return; // already authenticated (persisted token)
  if (sessionStorage.getItem(SIGNED_OUT_KEY)) return; // user chose to stay out
  await signInAs(pickUser());
}

// ---------------------------------------------------------------------------
// Tiny vanilla-DOM switcher (no React, so it stays entirely inside this
// dev-only chunk). Bottom-left so it doesn't collide with toasts/WriteStatus.
// ---------------------------------------------------------------------------
let panel: HTMLElement | null = null;

function mountSwitcher() {
  if (panel || typeof document === 'undefined') return;
  const build = () => {
    panel = document.createElement('div');
    panel.id = 'ucg-dev-auth';
    panel.style.cssText = [
      'position:fixed', 'bottom:12px', 'left:12px', 'z-index:99999',
      'background:#1e293b', 'color:#f8fafc', 'border:1px solid #475569',
      'border-radius:8px', 'padding:8px 10px', 'font:12px/1.3 system-ui,sans-serif',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)', 'max-width:240px',
    ].join(';');
    document.body.appendChild(panel);
    // Reflect external auth changes (e.g. sign-out elsewhere) in the highlight.
    supabase?.auth.onAuthStateChange(() => renderSwitcher());
    renderSwitcher();
  };
  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build, { once: true });
}

function renderSwitcher(activeRole?: string) {
  if (!panel) return;
  const current = activeRole ?? sessionStorage.getItem(ROLE_KEY) ?? '';
  panel.replaceChildren();

  const title = document.createElement('div');
  title.textContent = 'DEV AUTH';
  title.style.cssText = 'font-weight:700;letter-spacing:.06em;color:#cbd5e1;margin-bottom:6px';
  panel.appendChild(title);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  for (const u of DEV_USERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = u.label;
    const active = u.role === current;
    b.style.cssText = [
      'cursor:pointer', 'border-radius:5px', 'padding:4px 8px', 'font:inherit',
      `border:1px solid ${active ? '#38bdf8' : '#64748b'}`,
      `background:${active ? '#0ea5e9' : '#334155'}`,
      `color:${active ? '#04263a' : '#f8fafc'}`,
      active ? 'font-weight:700' : 'font-weight:500',
    ].join(';');
    b.onclick = () => { void signInAs(u); };
    row.appendChild(b);
  }
  panel.appendChild(row);
}
