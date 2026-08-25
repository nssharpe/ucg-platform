// Minimal imperative toast pub/sub, so non-React code — the write-queue boot
// wiring (supabase.ts) and the offline mutation gate (store.ts) — can surface a
// toast without going through React context (there is no component instance to
// call useToast() from at that point). ToastProvider (components/ui.tsx)
// subscribes on mount and renders through the SAME toast UI/state as
// useToast() — this is not a parallel mechanism, just an escape hatch into the
// existing one.
export type ToastOptions = {
  variant?: 'info' | 'error';
  persist?: boolean;
  /** UAT M-01-02: an optional single action rendered on the toast itself —
   *  e.g. "View cart" on a "Registration saved" toast, so the member doesn't
   *  have to hunt for the cart link after an edit. `to` is a route path
   *  (e.g. `/cart`, `/club/<id>/cart`); the toast renderer navigates via
   *  `window.location.hash` rather than `<Link>`/`useNavigate` because
   *  `ToastProvider` is mounted OUTSIDE `HashRouter` in App.tsx (so its own
   *  imperative escape-hatch subscribers — the write-queue, the offline
   *  gate — can toast without a Router in scope at all).
   *  D-09 (2026-08-25): a second action shape, `onClick`, for callers that
   *  need to run an arbitrary callback instead of a route hop — e.g. the PWA
   *  update prompt's "Refresh now" invoking `updateSW(true)`. Safe to pass a
   *  function through `pushToast` because this bus is in-memory pub/sub, not
   *  a serialized channel. */
  action?: { label: string; to: string } | { label: string; onClick: () => void };
};
type ToastListener = (msg: string, opts?: ToastOptions) => void;

const listeners = new Set<ToastListener>();

/** Push a toast from anywhere (component or plain module). No-ops if no
 *  ToastProvider is mounted yet (e.g. very early boot) — acceptable since the
 *  callers of this today only fire after the app (and its provider) is up. */
export function pushToast(msg: string, opts?: ToastOptions): void {
  listeners.forEach((l) => l(msg, opts));
}

/** Called by ToastProvider to receive pushToast() calls. Returns an unsubscribe. */
export function subscribeToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
