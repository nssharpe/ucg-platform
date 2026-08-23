import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchErrorLogs, type ErrorLogRow } from '../lib/supabase';
import { nextPageCursor } from '../lib/admin-errors-core';

const PAGE_SIZE = 200;

/** Admin-only client error log: search by user (email), message, or context to
 *  see what went wrong for someone — no screenshots required. One tab of the
 *  "Errors & Problems" admin page (AdminErrors.tsx), which owns the page
 *  heading/tabs; this component renders only the search box + table. */
export function ErrorLog() {
  const [rows, setRows] = useState<ErrorLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchErrorLogs({ limit: PAGE_SIZE }).then((r) => {
      if (!live) return;
      setRows(r);
      setHasMore(r.length === PAGE_SIZE);
      setLoading(false);
    });
    return () => { live = false; };
  }, []);

  const loadMore = async () => {
    const before = nextPageCursor(rows);
    if (!before) return;
    setLoadingMore(true);
    const more = await fetchErrorLogs({ limit: PAGE_SIZE, before });
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...prev, ...more.filter((r) => !seen.has(r.id))];
    });
    setHasMore(more.length === PAGE_SIZE);
    setLoadingMore(false);
  };

  const lq = q.trim().toLowerCase();
  const filtered = useMemo(() => !lq ? rows : rows.filter((r) =>
    (r.email ?? '').toLowerCase().includes(lq) ||
    r.message.toLowerCase().includes(lq) ||
    (r.context ?? '').toLowerCase().includes(lq),
  ), [rows, lq]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
        <input className="input" placeholder="Search by email / message / context…" value={q}
          onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{filtered.length} of {rows.length}</span>
      </div>

      {loading ? (
        <p style={{ color: 'var(--ink-soft)' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No errors{rows.length ? ' match your search' : ' recorded'}.</p>
      ) : (
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>When</th><th>User</th><th>Context</th><th>Message</th></tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <Fragment key={r.id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={{ fontSize: 12.5 }}>{r.email ?? <em style={{ color: 'var(--ink-soft)' }}>guest</em>}</td>
                      <td style={{ fontSize: 12.5 }}>{r.context ?? '—'}</td>
                      <td style={{ fontSize: 12.5 }}>{r.message.slice(0, 120)}</td>
                    </tr>
                    {expanded === r.id && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--surface-0)', fontSize: 12, padding: 12 }}>
                          <div><strong>URL:</strong> {r.url ?? '—'} · <strong>App:</strong> {r.appVersion ?? '—'}</div>
                          <div style={{ marginTop: 4 }}><strong>User agent:</strong> {r.userAgent ?? '—'}</div>
                          <div style={{ marginTop: 4 }}><strong>Message:</strong> {r.message}</div>
                          {r.stack && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto', marginTop: 6, fontSize: 11.5 }}>{r.stack}</pre>}
                          {r.detail != null && <pre style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontSize: 11.5 }}>{JSON.stringify(r.detail, null, 2)}</pre>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0' }}>
          <button className="btn ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

export default ErrorLog;
