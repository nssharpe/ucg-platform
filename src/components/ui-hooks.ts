import { createContext, useContext, useMemo } from 'react';
import type { ToastOptions } from '../lib/toast-bus';

// Non-component exports (a context + two hooks) live here rather than in ui.tsx
// so that ui.tsx exports only components — required for Vite fast-refresh
// (react-refresh/only-export-components). ToastProvider (in ui.tsx) imports
// ToastCtx from here.

// ---- Toasts ----
// `variant: 'error'` persists by default (no auto-dismiss) so errors can be read
// and screenshotted; pass `persist` to override either way. All toasts have a
// manual ✕ close. `ToastOptions` is re-exported from lib/toast-bus so both the
// React (useToast) and imperative (pushToast, for non-component code) entry
// points share one type.
export type { ToastOptions };
export const ToastCtx = createContext<(msg: string, opts?: ToastOptions) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

// ---- Date formatting ----
export function useFmtDate() {
  return useMemo(() => (iso: string) => new Date(iso + (iso.length === 10 ? 'T12:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), []);
}
