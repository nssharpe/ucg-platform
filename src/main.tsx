import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/archivo-black/400.css'
import '@fontsource-variable/instrument-sans/index.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { setErrorReporter, reportError } from './lib/report-error.ts'
import { logClientError } from './lib/supabase.ts'

// Forward every reported error to the durable, admin-searchable error log.
setErrorReporter((reported) => {
  void logClientError(reported);
});

// Catch errors that don't flow through an error boundary or the write queue.
window.addEventListener('error', (ev) => {
  reportError(ev.error ?? ev.message, 'window.onerror', { filename: ev.filename, line: ev.lineno });
});
window.addEventListener('unhandledrejection', (ev) => {
  reportError(ev.reason, 'unhandledrejection');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary variant="page" context="app-root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
