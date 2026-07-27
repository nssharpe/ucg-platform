// EventCommunicate — event-scoped communication (event-mgmt v2 §J).
//
// Mirrors src/pages/admin/Communicate.tsx (editor modes, preview, test send,
// comm_log logging) but scoped to ONE event's registrants, with per-email
// subject/reply-to/from-alias/cc. Split into its own file rather than folded
// into Events.tsx (already large) per the task brief.
//
// EDITOR DECISION: the HTML/rich-text editor + preview from Communicate.tsx
// was NOT lifted into a shared component — it's tightly coupled to that
// page's local `body`/`editorMode`/`previewMode` state and a shared
// `richRef`, so extracting it cleanly would mean threading 5+ props through
// a new component for a single reuse site. A self-contained copy (below) is
// simpler and keeps this page's diff local.
//
// AUTH SCOPE (controller/Nate decision, 2026-07-09 — deviation from spec §J):
// hosts (event managers + event_admins grantees) get EMAIL ONLY here. SMS
// stays league-admin-only — the channel toggle below only renders for
// caps.isAdmin, and it reuses the EXISTING league SMS path (send-sms +
// partitionByConsent) with recipients resolved CLIENT-side (admins can read
// all people). Revisit if hosts need SMS later.
//
// RECIPIENT COUNT: this page deliberately does NOT client-resolve or preview
// the email recipient list before sending — a host cannot read other clubs'
// people, so any client-side preview would either be wrong or require a
// second server round-trip. The count shown is whatever the send (or test
// send) call returns.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useEventRegistrations } from '../lib/registrations-slice';
import { useCapabilities } from '../lib/capabilities';
import { useRolesLoaded } from '../lib/auth';
import { useToast } from '../components/ui-hooks';
import { Badge, Field } from '../components/ui';
import { sendEventEmail, sendSms, logComm, fetchCommLog, type CommLogEntry } from '../lib/supabase';
import { analyzeMessage } from '../lib/sms-segments';
import { estimateSmsCost, partitionByConsent } from '../lib/sms-send';
import { matchesEventCommFilters, type EventCommRole } from '../../supabase/functions/_shared/event-comm';
import type { Discipline } from '../lib/types';

const ROLE_OPTIONS: { key: EventCommRole; label: string }[] = [
  { key: 'athlete', label: 'Athletes' },
  { key: 'manager', label: 'Club managers' },
  { key: 'clubEmail', label: 'Club emails' },
];

export function EventCommunicate() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const rolesLoaded = useRolesLoaded();
  const event = db.events.find((e) => e.slug === slug);

  // --- Message state (mirrors Communicate.tsx) ---
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [editorMode, setEditorMode] = useState<'html' | 'rich'>('html');
  const [previewMode, setPreviewMode] = useState(false);
  const [replyTo, setReplyTo] = useState('');
  const [fromAlias, setFromAlias] = useState('');
  const [ccInput, setCcInput] = useState('');

  // --- Filters ---
  const [roles, setRoles] = useState<Set<EventCommRole>>(new Set());
  const [sessionIds, setSessionIds] = useState<Set<string>>(new Set());
  const [levelIds, setLevelIds] = useState<Set<string>>(new Set());
  const [disciplines, setDisciplines] = useState<Set<Discipline>>(new Set());

  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ sent: number; failed: number; recipientCount: number; isTest: boolean } | null>(null);

  // Admin-only SMS toggle (hosts never see this — see file header).
  const [channel, setChannel] = useState<'email' | 'sms'>('email');

  // --- Per-event sent log ---
  const [logOpen, setLogOpen] = useState(false);
  const [logRefresh, setLogRefresh] = useState(0);
  const [commLog, setCommLog] = useState<(CommLogEntry & { id: string; sentAt: string })[]>([]);
  useEffect(() => {
    if (!logOpen || !event) return;
    let live = true;
    void fetchCommLog(100, event.id).then((rows) => { if (live) setCommLog(rows); });
    return () => { live = false; };
  }, [logOpen, logRefresh, event]);

  // Rich-text editor ref (mirrors Communicate.tsx)
  const richRef = useRef<HTMLDivElement>(null);
  const execCmd = useCallback((cmd: string, value?: string) => {
    document.execCommand(cmd, false, value);
    if (richRef.current) setBody(richRef.current.innerHTML);
  }, []);
  const onRichInput = useCallback(() => { if (richRef.current) setBody(richRef.current.innerHTML); }, []);
  const switchToRich = () => {
    setEditorMode('rich');
    setPreviewMode(false);
    setTimeout(() => { if (richRef.current) richRef.current.innerHTML = body; }, 0);
  };
  const switchToHtml = () => setEditorMode('html');

  // Levels referenced by this event's sessions, for the level filter checkboxes.
  const eventLevels = useMemo(() => {
    if (!event) return [];
    const ids = new Set(event.sessions.flatMap((s) => s.levelIds));
    return db.levels.filter((l) => ids.has(l.id));
  }, [event, db.levels]);

  if (!event) return <div className="page"><p>Event not found.</p></div>;
  if (!rolesLoaded) return <div className="page"><p>Loading…</p></div>;

  const canManage = caps.isEventHost(event.id) || caps.isSanctioning;
  if (!canManage) {
    return (
      <div className="page">
        <p>You don't have access to email this event's registrants. Contact the event host or a UCG administrator if you believe this is an error.</p>
      </div>
    );
  }

  const toggleSet = <T,>(set: Set<T>, setSet: (s: Set<T>) => void, val: T) => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val); else next.add(val);
    setSet(next);
  };

  const cc = ccInput.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);

  const filters = {
    roles: [...roles],
    sessionIds: sessionIds.size ? [...sessionIds] : undefined,
    levelIds: levelIds.size ? [...levelIds] : undefined,
    disciplines: disciplines.size ? [...disciplines] : undefined,
  };

  const sendEmailNow = async (test: boolean) => {
    if (!subject.trim()) { toast('Add a subject before sending.'); return; }
    if (!body.trim()) { toast('Add an email body before sending.'); return; }
    if (!test && roles.size === 0) { toast('Select at least one recipient role.'); return; }
    if (!test && !window.confirm(`Send this email to the event's ${[...roles].join(', ')} audience now?`)) return;
    setSending(true);
    try {
      const res = await sendEventEmail({
        eventId: event.id, subject: subject.trim(), html: body, replyTo: replyTo.trim() || undefined,
        fromAlias: fromAlias.trim() || undefined, cc: cc.length ? cc : undefined, filters, test,
      });
      if (res.ok) {
        toast(`${test ? 'Test email' : 'Email'} sent to ${res.sent} recipient${res.sent !== 1 ? 's' : ''}${res.failed ? ` (${res.failed} failed)` : ''}.`);
        setLastResult({ sent: res.sent, failed: res.failed, recipientCount: res.recipientCount, isTest: test });
        await logComm({
          channel: 'email', isTest: test, subject: subject.trim(), body,
          recipientCount: res.recipientCount, sentCount: res.sent, failedCount: res.failed,
          recipients: [], error: null, eventId: event.id,
        });
        setLogRefresh((n) => n + 1);
      } else {
        toast(`Send failed: ${res.error ?? 'unknown error'}`, { variant: 'error' });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{event.name} — Email registrants</h1>
          <p className="page-sub">HTML email to this event's registrants, filtered by session/level/discipline.</p>
        </div>
        <Link className="btn ghost small" to={`/events/${event.slug}/host`}>← Host dashboard</Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* ---- Left: Audience filters ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Audience</h3>
          <Field label="Roles">
            {ROLE_OPTIONS.map(({ key, label }) => (
              <label className="checkrow" key={key}>
                <input type="checkbox" checked={roles.has(key)} onChange={() => toggleSet(roles, setRoles, key)} />{label}
              </label>
            ))}
          </Field>
          {event.disciplines.length > 1 && (
            <Field label="Disciplines (blank = all)">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
                {event.disciplines.map((d) => (
                  <label className="checkrow" key={d}>
                    <input type="checkbox" checked={disciplines.has(d)} onChange={() => toggleSet(disciplines, setDisciplines, d)} />{d}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {event.sessions.length > 0 && (
            <Field label="Sessions (blank = all)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflowY: 'auto' }}>
                {event.sessions.map((s) => (
                  <label className="checkrow" key={s.id}>
                    <input type="checkbox" checked={sessionIds.has(s.id)} onChange={() => toggleSet(sessionIds, setSessionIds, s.id)} />{s.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {eventLevels.length > 0 && (
            <Field label="Levels (blank = all)">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', maxHeight: 160, overflowY: 'auto' }}>
                {eventLevels.map((l) => (
                  <label className="checkrow" key={l.id}>
                    <input type="checkbox" checked={levelIds.has(l.id)} onChange={() => toggleSet(levelIds, setLevelIds, l.id)} />{l.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 8 }}>
            Recipients are resolved on send — a host can't browse other clubs' contact lists here.
            The exact count appears after you send.
          </p>
        </div>

        {/* ---- Right: Message ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Message</h3>

          {caps.isAdmin && (
            <Field label="Channel">
              <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}>
                <option value="email">Email (HTML supported)</option>
                <option value="sms">Text message (admin-only)</option>
              </select>
            </Field>
          )}

          {channel === 'email' && (
            <>
              <Field label="Subject">
                <input className="input" type="text" placeholder="Event schedule update" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </Field>
              <Field label="Reply-to (optional)">
                <input className="input" type="email" placeholder="director@example.com" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
              </Field>
              <Field label="From-alias (optional — display name only)">
                <input className="input" type="text" placeholder={event.name} value={fromAlias} onChange={(e) => setFromAlias(e.target.value)} />
              </Field>
              <Field label="CC (optional, comma-separated, up to 5)">
                <input className="input" type="text" placeholder="a@example.com, b@example.com" value={ccInput} onChange={(e) => setCcInput(e.target.value)} />
              </Field>

              <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Editor:</span>
                <button className={`btn small ${editorMode === 'html' ? 'primary' : 'ghost'}`} onClick={switchToHtml}>HTML</button>
                <button className={`btn small ${editorMode === 'rich' ? 'primary' : 'ghost'}`} onClick={switchToRich}>Rich text</button>
                {editorMode === 'html' && (
                  <button className={`btn small ${previewMode ? 'primary' : 'ghost'}`} style={{ marginLeft: 'auto' }} onClick={() => setPreviewMode((v) => !v)}>
                    {previewMode ? 'Edit HTML' : 'Preview'}
                  </button>
                )}
              </div>

              {editorMode === 'html' && (
                previewMode ? (
                  <div
                    style={{ minHeight: 160, maxHeight: 340, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px', background: '#fff', color: '#111', fontSize: 14, lineHeight: 1.6 }}
                    // Event-host tool; body is host-authored HTML, same trust model as Communicate.tsx
                    dangerouslySetInnerHTML={{ __html: body }}
                  />
                ) : (
                  <textarea
                    className="input" rows={8} style={{ fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical' }}
                    placeholder={'<h1>Hi {{first_name}},</h1>\n<p>…</p>'} value={body} onChange={(e) => setBody(e.target.value)}
                  />
                )
              )}

              {editorMode === 'rich' && (
                <div>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                    {([
                      ['Bold', 'bold', '<b>B</b>'],
                      ['Italic', 'italic', '<i>I</i>'],
                      ['Bullets', 'insertUnorderedList', '• List'],
                    ] as const).map(([label, cmd, html]) => (
                      <button key={cmd} className="btn small ghost" onMouseDown={(e) => { e.preventDefault(); execCmd(cmd); }} dangerouslySetInnerHTML={{ __html: html }} aria-label={label} />
                    ))}
                    <button
                      className="btn small ghost"
                      onMouseDown={(e) => { e.preventDefault(); const url = window.prompt('Link URL:', 'https://'); if (url) execCmd('createLink', url); }}
                    >🔗 Link</button>
                  </div>
                  <div
                    ref={richRef} contentEditable suppressContentEditableWarning onInput={onRichInput}
                    style={{ minHeight: 160, maxHeight: 340, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px', background: '#fff', color: '#111', fontSize: 14, lineHeight: 1.6, outline: 'none' }}
                  />
                </div>
              )}
            </>
          )}

          {channel === 'sms' && caps.isAdmin && (
            <SmsSection event={event} db={db} roles={roles} sessionIds={sessionIds} levelIds={levelIds} disciplines={disciplines} toast={toast} onSent={() => setLogRefresh((n) => n + 1)} eventId={event.id} />
          )}
        </div>
      </div>

      {channel === 'email' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start', marginTop: 16 }}>
          <div className="card card-pad">
            <h3 className="card-title">Send to selected audience</h3>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
              Sends to the registrants matching your Audience filters. The exact recipient count is
              resolved on send and shown below.
            </p>
            <button className="btn primary" disabled={sending || roles.size === 0} onClick={() => sendEmailNow(false)}>
              {sending ? 'Sending…' : 'Send →'}
            </button>
            {lastResult && !lastResult.isTest && (
              <p style={{ marginTop: 10, fontSize: 13.5 }}>
                Last send: <strong>{lastResult.sent}</strong> sent{lastResult.failed ? `, ${lastResult.failed} failed` : ''} of {lastResult.recipientCount} resolved.
              </p>
            )}
          </div>
          <div className="card card-pad">
            <h3 className="card-title">Send test email</h3>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
              Sends the composed message to YOUR OWN account email only — there's no arbitrary test-recipient picker here.
            </p>
            <button className="btn ghost" disabled={sending} onClick={() => sendEmailNow(true)}>
              {sending ? 'Sending…' : 'Send test to myself'}
            </button>
            {lastResult?.isTest && (
              <p style={{ marginTop: 10, fontSize: 13.5 }}>Test sent: {lastResult.sent} sent{lastResult.failed ? `, ${lastResult.failed} failed` : ''}.</p>
            )}
          </div>
        </div>
      )}

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 className="card-title" style={{ margin: 0 }}>Sent log</h3>
          <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => setLogOpen((v) => !v)}>{logOpen ? 'Hide' : 'Show'}</button>
        </div>
        {logOpen && (
          commLog.length === 0 ? (
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 10 }}>No sends recorded yet for this event.</p>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {commLog.map((c) => {
                const when = new Date(c.sentAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const ok = (c.failedCount ?? 0) === 0 && !c.error;
                return (
                  <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', fontSize: 13 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone={c.channel === 'sms' ? 'navy' : 'info'}>{c.channel === 'sms' ? 'Text' : 'Email'}</Badge>
                      {c.isTest && <Badge tone="warn">Test</Badge>}
                      <span>{when}</span>
                      <span style={{ color: 'var(--ink-soft)' }}>
                        {c.recipientCount} recipient{c.recipientCount !== 1 ? 's' : ''}
                        {c.sentCount != null && ` · ${c.sentCount} sent${c.failedCount ? `, ${c.failedCount} failed` : ''}`}
                      </span>
                      <Badge tone={ok ? 'ok' : 'err'}>{ok ? 'Sent' : 'Issues'}</Badge>
                      {c.subject && <span style={{ marginLeft: 'auto', color: 'var(--ink-soft)' }}>{c.subject}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** Admin-only SMS channel (see file header) — reuses the league SMS path
 *  (send-sms + partitionByConsent), resolving recipients CLIENT-side from
 *  `db` (admins can read all people) with the same event/role/session/level/
 *  discipline filters as the email side. `clubEmail` has no meaningful SMS
 *  analog (clubs don't have a phone) and is silently ignored here. */
function SmsSection({
  event, db, roles, sessionIds, levelIds, disciplines, toast, onSent, eventId,
}: {
  event: import('../lib/types').Event;
  db: import('../lib/types').DB;
  roles: Set<EventCommRole>;
  sessionIds: Set<string>;
  levelIds: Set<string>;
  disciplines: Set<Discipline>;
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
  onSent: () => void;
  eventId: string;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  // Phase 3 (data-layer-scale): reads the by-event slice instead of
  // db.registrations directly — this also fixes a pre-existing bug
  // independent of the slice migration: mutate() never reassigns
  // db.registrations on an in-place update (CLAUDE.md's M6 trap), so this
  // useMemo, keyed on the array reference, could go stale after an edit.
  // eventRegs is a fresh array reference on every slice update, so it
  // doesn't carry that trap.
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(eventId);
  const matched = useMemo(() => {
    const filters = {
      sessionIds: sessionIds.size ? [...sessionIds] : undefined,
      levelIds: levelIds.size ? [...levelIds] : undefined,
      disciplines: disciplines.size ? [...disciplines] : undefined,
    };
    return eventRegs.filter((r) => r.eventId === eventId && matchesEventCommFilters(
      { session_id: r.sessionId || null, level_id: r.levelId || null, discipline: r.discipline, refunded: r.refunded ?? false },
      filters,
    ));
  }, [eventRegs, eventId, sessionIds, levelIds, disciplines]);

  const recipients = useMemo(() => {
    const personIds = new Set<string>();
    if (roles.has('athlete')) matched.forEach((r) => personIds.add(r.athleteId));
    if (roles.has('manager')) {
      const clubIds = new Set(matched.map((r) => r.clubId).filter(Boolean));
      db.clubs.filter((c) => clubIds.has(c.id)).forEach((c) => c.managerIds.forEach((id) => personIds.add(id)));
    }
    return db.people.filter((p) => personIds.has(p.id));
  }, [matched, roles, db.clubs, db.people]);

  const withPhone = recipients.filter((p) => p.phone);
  const { eligible, excluded } = partitionByConsent(withPhone);
  const seg = analyzeMessage(text);

  const send = async () => {
    if (!text.trim()) { toast('Add a message before sending.'); return; }
    if (eligible.length === 0) { toast('No opted-in recipients with a phone match these filters.'); return; }
    if (!window.confirm(`Send this text to ${eligible.length} recipient${eligible.length !== 1 ? 's' : ''}?`)) return;
    setSending(true);
    try {
      const valid = eligible.map((p) => ({ phone: p.phone!, name: `${p.firstName} ${p.lastName}` }));
      const res = await sendSms(text, valid);
      if (res.ok) toast(`Sent to ${res.sentCount} recipient${res.sentCount !== 1 ? 's' : ''}.`);
      else if (res.sentCount > 0) toast(`${res.sentCount} sent, ${res.failedCount} failed.`);
      else toast(`Send failed: ${res.error ?? 'unknown error'}`, { variant: 'error' });
      await logComm({
        channel: 'sms', isTest: false, subject: null, body: text,
        recipientCount: valid.length, sentCount: res.sentCount ?? null, failedCount: res.failedCount ?? null,
        recipients: valid.map((v) => ({ name: v.name, contact: v.phone })), error: res.ok ? null : (res.error ?? null),
        segments: seg.segments, encoding: seg.encoding, costEstimate: estimateSmsCost(seg.segments, res.sentCount ?? valid.length),
        eventId: event.id,
      });
      onSent();
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Field label="Message">
        <textarea className="input" rows={4} maxLength={612} placeholder="UCG: schedule update — check the app for details." value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>{seg.length} chars · {seg.segments} segment{seg.segments !== 1 ? 's' : ''}</div>
      </Field>
      {regsStatus === 'loading' ? (
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Loading recipients…</p>
      ) : (
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
          {eligible.length} eligible recipient{eligible.length !== 1 ? 's' : ''}
          {excluded.length ? ` (${excluded.length} skipped — no SMS consent)` : ''}
          {withPhone.length < recipients.length ? `, ${recipients.length - withPhone.length} without a phone` : ''}.
        </p>
      )}
      <button className="btn primary" disabled={sending || regsStatus !== 'ready' || eligible.length === 0} onClick={send}>
        {sending ? 'Sending…' : `Send text to ${eligible.length} →`}
      </button>
    </>
  );
}
