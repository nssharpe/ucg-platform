import { createContext, useContext, useMemo } from 'react';

// Non-component exports (a context + two hooks) live here rather than in ui.tsx
// so that ui.tsx exports only components — required for Vite fast-refresh
// (react-refresh/only-export-components). ToastProvider (in ui.tsx) imports
// ToastCtx from here.

// ---- Toasts ----
export const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

// ---- Date formatting ----
export function useFmtDate() {
  return useMemo(() => (iso: string) => new Date(iso + (iso.length === 10 ? 'T12:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), []);
}
