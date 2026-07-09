import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { reportError } from '../lib/report-error';
import primaryLogo from '../assets/brand/primary-logo.svg';

interface Props {
  children: ReactNode;
  /** Distinguishes the full-page (app) boundary from per-route boundaries. */
  variant?: 'page' | 'route';
  /** Identifies where the boundary sits (route path) for reporting + reset. */
  context?: string;
  /**
   * When any value here changes the boundary auto-resets. The route boundary
   * passes the current pathname so navigating away from a broken page clears
   * the error without a manual reload.
   */
  resetKeys?: unknown[];
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in its subtree, reports them (→ Sentry later
 * via report-error), and shows a branded fallback instead of a white screen.
 *
 * Two roles:
 *  - `variant="page"` wraps the whole app (outside the router) → full-page
 *    fallback with reload/report. Catches crashes in the shell itself.
 *  - `variant="route"` wraps the routed page (inside the layout) and resets on
 *    navigation, so one broken page shows an inline error while the nav/topbar
 *    stay usable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Auto-reset when the resetKeys change (e.g. route navigation).
    if (this.state.error && prev.resetKeys && this.props.resetKeys) {
      const changed =
        prev.resetKeys.length !== this.props.resetKeys.length ||
        prev.resetKeys.some((k, i) => !Object.is(k, this.props.resetKeys![i]));
      if (changed) this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, this.props.context ?? `react-${this.props.variant ?? 'route'}`, {
      componentStack: info.componentStack,
      variant: this.props.variant ?? 'route',
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.variant === 'page') {
      return (
        <div className="errboundary-page">
          <div className="errboundary-card">
            <img src={primaryLogo} alt="United Club Gymnastics" className="errboundary-logo" />
            <h1 className="errboundary-title">Something broke</h1>
            <p className="errboundary-msg">
              The app hit an unexpected error and couldn't continue. Your data is safe —
              reloading usually fixes it.
            </p>
            <div className="errboundary-actions">
              <button className="btn" onClick={() => window.location.reload()}>Reload the app</button>
              <a className="btn ghost" href="mailto:nate.sharpe@naigc.org?subject=UCG%20bug%20report">
                Report it
              </a>
            </div>
            <ErrorDetails error={error} />
          </div>
        </div>
      );
    }

    return (
      <div className="errboundary-route">
        <div className="errboundary-route-icon">⚠️</div>
        <h2 className="errboundary-title">This page hit an error</h2>
        <p className="errboundary-msg">
          Something on this page failed to load. You can try again, or use the menu to go
          somewhere else.
        </p>
        <div className="errboundary-actions">
          <button className="btn" onClick={this.reset}>Try again</button>
          <a className="btn ghost" href="mailto:nate.sharpe@naigc.org?subject=UCG%20bug%20report">
            Report it
          </a>
        </div>
        <ErrorDetails error={error} />
      </div>
    );
  }
}

/** Collapsed technical detail — handy for bug reports, out of the way otherwise. */
function ErrorDetails({ error }: { error: Error }) {
  return (
    <details className="errboundary-details">
      <summary>Technical details</summary>
      <pre>{error.message}{error.stack ? `\n\n${error.stack}` : ''}</pre>
    </details>
  );
}
