// Minimal imperative toast pub/sub, so non-React code — the write-queue boot
// wiring (supabase.ts) and the offline mutation gate (store.ts) — can surface a
// toast without going through React context (there is no component instance to
// call useToast() from at that point). ToastProvider (components/ui.tsx)
// subscribes on mount and renders through the SAME toast UI/state as
// useToast() — this is not a parallel mechanism, just an escape hatch into the
// existing one.
export type ToastOptions = { variant?: 'info' | 'error'; persist?: boolean };
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
