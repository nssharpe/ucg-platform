import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Modal, Tabs } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { fetchProblemReports, updateProblemReportStatus, type ProblemReportRow } from '../lib/supabase';
import { filterProblemReports, nextPageCursor, type ProblemCategory } from '../lib/admin-errors-core';
import { ErrorLog } from './ErrorLog';

const PAGE_SIZE = 200;

const CATEGORY_LABEL: Record<ProblemCategory, string> = { bug: 'Bug', question: 'Question', unsure: 'Unsure' };
const CATEGORY_TONE: Record<ProblemCategory, 'err' | 'info' | 'navy'> = { bug: 'err', question: 'info', unsure: 'navy' };

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Admin-only "Errors & Problems" page (nav label renamed from "Error Log" —
 *  UAT round 1 new ask, 2026-08-22). Two tabs: Problem Reports (durable
 *  record of user-submitted "Report a problem" submissions — persisted
 *  server-side by report-problem alongside its existing email alert) and
 *  Error Log (the pre-existing automatic front-end error capture,
 *  unchanged except for added "Load more" pagination). */
export function AdminErrors() {
  const [tab, setTab] = useState<'reports' | 'errorlog'>('reports');
  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 className="page-title display">Errors & Problems</h1>
      <p className="page-sub">User-submitted problem reports and front-end error captures.</p>
      <Tabs
        tabs={[{ id: 'reports', label: 'Problem Reports' }, { id: 'errorlog', label: 'Error Log' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'reports' ? <ProblemReports /> : <ErrorLog />}
    </div>
  );
}

function ProblemReports() {
  const toast = useToast();
  const [statusTab, setStatusTab] = useState<'open' | 'resolved' | 'all'>('open');
  const [rows, setRows] = useState<ProblemReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<ProblemCategory | 'all'>('all');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<ProblemReportRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const serverStatus = statusTab === 'all' ? undefined : statusTab;

  // `loading` is set to `true` by the status-tab `onChange` handler below
  // (a genuine event-handler setState, not an effect one) and by this
  // component's initial `useState(true)`, so `load` itself only ever sets
  // state inside the `.then()` — the effect's own synchronous body never
  // calls setState directly (react-hooks/set-state-in-effect).
  const load = useCallback((status: 'open' | 'resolved' | undefined) => {
    void fetchProblemReports({ status, limit: PAGE_SIZE }).then((r) => {
      setRows(r);
      setHasMore(r.length === PAGE_SIZE);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(serverStatus); }, [serverStatus, load]);

  const loadMore = async () => {
    const before = nextPageCursor(rows);
    if (!before) return;
    setLoadingMore(true);
    const more = await fetchProblemReports({ status: serverStatus, limit: PAGE_SIZE, before });
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...prev, ...more.filter((r) => !seen.has(r.id))];
    });
    setHasMore(more.length === PAGE_SIZE);
    setLoadingMore(false);
  };

  // A resolve/reopen can move a row OUT of the currently-viewed status tab
  // (server-scoped fetch — see fetchProblemReports' doc comment) — drop it
  // from local state in that case instead of leaving a stale row behind
  // until the next full refetch.
  const applyUpdate = (updated: ProblemReportRow) => {
    setRows((prev) => {
      if (statusTab !== 'all' && updated.status !== statusTab) return prev.filter((r) => r.id !== updated.id);
      return prev.map((r) => (r.id === updated.id ? updated : r));
    });
  };

  const handleResolveConfirm = async (note: string) => {
    if (!resolving) return;
    setBusyId(resolving.id);
    const res = await updateProblemReportStatus(resolving.id, 'resolved', note);
    setBusyId(null);
    if (!res.ok) { toast(res.error ?? 'Could not resolve — try again.', { variant: 'error' }); return; }
    setResolving(null);
    applyUpdate(res.row!);
    toast('Marked resolved.');
  };

  const handleReopen = async (row: ProblemReportRow) => {
    if (!window.confirm('Reopen this problem report?')) return;
    setBusyId(row.id);
    const res = await updateProblemReportStatus(row.id, 'open');
    setBusyId(null);
    if (!res.ok) { toast(res.error ?? 'Could not reopen — try again.', { variant: 'error' }); return; }
    applyUpdate(res.row!);
    toast('Reopened.');
  };

  const filtered = useMemo(() => {
    const f = filterProblemReports(rows, { q, category });
    return [...f].sort((a, b) => sortDir === 'desc'
      ? b.createdAt.localeCompare(a.createdAt)
      : a.createdAt.localeCompare(b.createdAt));
  }, [rows, q, category, sortDir]);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '12px 0' }}>
        <input className="input" placeholder="Search description / reporter / route…" value={q}
          onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, flex: '1 1 240px' }} />
        <select className="input" style={{ maxWidth: 160 }} value={statusTab}
          onChange={(e) => { setStatusTab(e.target.value as typeof statusTab); setLoading(true); }}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
        <select className="input" style={{ maxWidth: 160 }} value={category}
          onChange={(e) => setCategory(e.target.value as typeof category)}>
          <option value="all">All categories</option>
          <option value="bug">Bug</option>
          <option value="question">Question</option>
          <option value="unsure">Unsure</option>
        </select>
        <select className="input" style={{ maxWidth: 150 }} value={sortDir}
          onChange={(e) => setSortDir(e.target.value as typeof sortDir)}>
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{filtered.length} of {rows.length}</span>
      </div>

      {loading ? (
        <p style={{ color: 'var(--ink-soft)' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No problem reports{rows.length ? ' match your search/filter' : '.'}</p>
      ) : (
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Created</th><th>Category</th><th>Reporter</th><th>Route</th><th>Build</th>
                  <th>Description</th><th>Screenshots</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const reporter = r.reporterName
                    ? `${r.reporterName}${r.reporterEmail ? ` (${r.reporterEmail})` : ''}`
                    : (r.reporterEmail ?? 'Unknown');
                  const isExpanded = expanded === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(isExpanded ? null : r.id)}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{fmtDateTime(r.createdAt)}</td>
                        <td><Badge tone={CATEGORY_TONE[r.category]}>{CATEGORY_LABEL[r.category]}</Badge></td>
                        <td style={{ fontSize: 12.5 }}>{reporter}</td>
                        <td style={{ fontSize: 12.5 }}>{r.route ?? '—'}</td>
                        <td style={{ fontSize: 12.5 }}>{r.appVersion ?? '—'}</td>
                        <td style={{ fontSize: 12.5, maxWidth: 260 }}>
                          {isExpanded ? r.description : `${r.description.slice(0, 90)}${r.description.length > 90 ? '…' : ''}`}
                        </td>
                        <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                          {r.attachmentCount > 0 ? `${r.attachmentCount} screenshot${r.attachmentCount === 1 ? '' : 's'} — see email` : '—'}
                        </td>
                        <td><Badge tone={r.status === 'open' ? 'warn' : 'ok'}>{r.status}</Badge></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {r.status === 'open' ? (
                            <button className="btn ghost small" disabled={busyId === r.id} onClick={() => setResolving(r)}>
                              Resolve
                            </button>
                          ) : (
                            <button className="btn ghost small" disabled={busyId === r.id} onClick={() => void handleReopen(r)}>
                              {busyId === r.id ? 'Working…' : 'Reopen'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={9} style={{ background: 'var(--surface-0)', fontSize: 12, padding: 12 }}>
                            <div><strong>User agent:</strong> {r.userAgent ?? '—'}</div>
                            {Array.isArray(r.recentErrors) && r.recentErrors.length > 0 && (
                              <>
                                <div style={{ marginTop: 6, fontWeight: 700 }}>Recent console errors</div>
                                <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', marginTop: 4, fontSize: 11.5 }}>
                                  {(r.recentErrors as string[]).join('\n')}
                                </pre>
                              </>
                            )}
                            {r.status === 'resolved' && (
                              <div style={{ marginTop: 6 }}>
                                <strong>Resolved:</strong> {r.resolvedAt ? fmtDateTime(r.resolvedAt) : '—'}
                                {r.resolutionNote && <div style={{ marginTop: 2 }}><strong>Note:</strong> {r.resolutionNote}</div>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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

      {resolving && (
        <ResolveDialog
          report={resolving}
          busy={busyId === resolving.id}
          onCancel={() => setResolving(null)}
          onConfirm={(note) => void handleResolveConfirm(note)}
        />
      )}
    </div>
  );
}

function ResolveDialog({ report, busy, onCancel, onConfirm }: {
  report: ProblemReportRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal title="Resolve problem report" onClose={onCancel}>
      <p style={{ fontSize: 14 }}>
        Mark this {CATEGORY_LABEL[report.category].toLowerCase()} report from{' '}
        <strong>{report.reporterName || report.reporterEmail || 'Unknown reporter'}</strong> as resolved?
      </p>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, margin: '12px 0 4px' }}>
        Resolution note (optional)
      </label>
      <textarea
        className="input"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What was done, or why no action was needed…"
        aria-label="Resolution note"
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={() => onConfirm(note)} disabled={busy}>
          {busy ? 'Working…' : 'Mark resolved'}
        </button>
      </div>
    </Modal>
  );
}

export default AdminErrors;
