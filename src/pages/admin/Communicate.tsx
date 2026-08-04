import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDB } from '../../lib/store';
import { Badge, Combo, Field } from '../../components/ui';
import { useToast } from '../../components/ui-hooks';
import { STATE_REGIONS } from '../../lib/types';
import type { Athlete, Region } from '../../lib/types';
import { isSupabaseConfigured, sendEmail, sendSms, logComm, fetchCommLog, fetchSmsMessages, type CommLogEntry, type SmsMessage } from '../../lib/supabase';
import { analyzeMessage, normalizeToGsm7 } from '../../lib/sms-segments';
import { estimateSmsCost, partitionByConsent } from '../../lib/sms-send';
import { classifyDeliveryStatus } from '../../lib/sms-inbound';
import { currentSeason } from '../../lib/season-lifecycle';
import { useAdminMemberships, groupAdminMembershipsByPerson } from '../../lib/memberships-admin-slice';
import { useAdminPeople } from '../../lib/people-admin-slice';

// ---------- Communicate ----------

interface SendRecord {
  sentAt: Date;
  channel: 'email' | 'sms';
  recipientCount: number;
  recipients: { name: string; contact: string }[];
}

export function Communicate() {
  const db = useDB();
  const toast = useToast();
  const season = currentSeason(db)!;
  // Default to NO audience selected to avoid accidental org-wide sends (2026-06-22).
  const [aud, setAud] = useState({ athletes: false, coaches: false, managers: false, clubEmails: false, withMembership: 'any' as 'any' | 'with' | 'without' });
  const [regions, setRegions] = useState<Region[]>([]);
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const allRegions = [...new Set(Object.values(STATE_REGIONS))] as Region[];

  // Message state
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Editor mode: 'html' = raw textarea, 'rich' = contentEditable toolbar
  const [editorMode, setEditorMode] = useState<'html' | 'rich'>('html');
  // Preview mode for the html pane
  const [previewMode, setPreviewMode] = useState(false);
  // Recipient list expanded
  const [listExpanded, setListExpanded] = useState(false);

  // Send log
  const [lastSend, setLastSend] = useState<SendRecord | null>(null);
  const [sendLogExpanded, setSendLogExpanded] = useState(false);

  // Persistent communication history (comm_log)
  const [logRefresh, setLogRefresh] = useState(0);
  const [commLog, setCommLog] = useState<(CommLogEntry & { id: string; sentAt: string })[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  useEffect(() => {
    if (!historyOpen) return;
    let live = true;
    void fetchCommLog().then((rows) => { if (live) setCommLog(rows); });
    return () => { live = false; };
  }, [historyOpen, logRefresh]);

  // Per-message SMS activity (sms_messages): inbound replies + delivery status.
  const [smsMessages, setSmsMessages] = useState<SmsMessage[]>([]);
  const [smsActivityOpen, setSmsActivityOpen] = useState(false);
  const [smsActivityRefresh, setSmsActivityRefresh] = useState(0);
  const [smsLoading, setSmsLoading] = useState(false);
  useEffect(() => {
    if (!smsActivityOpen) return;
    let live = true;
    void fetchSmsMessages().then((rows) => { if (live) { setSmsMessages(rows); setSmsLoading(false); } });
    return () => { live = false; };
  }, [smsActivityOpen, smsActivityRefresh]);
  // Loading is flipped on by the open/refresh handlers (not the effect) to avoid
  // a synchronous setState-in-effect; the fetch's .then turns it back off.
  const openSmsActivity = () => {
    const next = !smsActivityOpen;
    setSmsActivityOpen(next);
    if (next) setSmsLoading(true);
  };
  const refreshSmsActivity = () => { setSmsLoading(true); setSmsActivityRefresh((n) => n + 1); };
  const inboundMsgs = useMemo(() => smsMessages.filter((m) => m.direction === 'inbound'), [smsMessages]);
  const outboundMsgs = useMemo(() => smsMessages.filter((m) => m.direction === 'outbound'), [smsMessages]);

  // Test send
  const [testPersonId, setTestPersonId] = useState<string | null>(null);
  const [testGroup, setTestGroup] = useState<Athlete[]>([]);
  const [sending, setSending] = useState(false);

  // Send the current subject/body to an explicit recipient list via the
  // send-email (Gmail SMTP) or send-sms (Telnyx) Edge Function, per channel.
  // Used by both the test and main sends.
  const doSend = async (people: { email?: string; phone?: string; name?: string; smsConsent?: boolean }[], label: string) => {
    if (!isSupabaseConfigured) { toast(`${channel === 'sms' ? 'SMS' : 'Email'} needs Supabase configured to send.`); return; }
    if (!body.trim()) { toast(`Add a ${channel === 'sms' ? 'message' : 'email body'} before sending.`); return; }

    if (channel === 'sms') {
      const withPhone = people.filter((p) => p.phone);
      if (withPhone.length === 0) { toast('No recipients have a phone number.'); return; }
      // Enforce SMS consent on every send (test and audience): only opted-in
      // numbers are texted. Non-consented recipients are dropped here.
      const { eligible, excluded } = partitionByConsent(withPhone);
      if (eligible.length === 0) {
        toast(`None of the ${withPhone.length} recipient${withPhone.length !== 1 ? 's' : ''} with a phone have opted in to SMS.`, { variant: 'error' });
        return;
      }
      const valid = eligible.map((p) => ({ phone: p.phone!, name: p.name }));
      const skipNote = excluded.length ? ` (${excluded.length} skipped — no SMS consent)` : '';
      if (valid.length > 10 && !window.confirm(`Are you sure you want to send a text message to ${valid.length} people${skipNote}?`)) return;
      // Confirm before spending on a multi-segment blast (each segment is billed).
      const seg = analyzeMessage(body);
      if (seg.segments > 1 && !window.confirm(
        `This message is ${seg.segments} ${seg.encoding} segments — each recipient is billed ${seg.segments}×. ` +
        `Send to ${valid.length} recipient${valid.length !== 1 ? 's' : ''}${skipNote} anyway?`,
      )) return;
      setSending(true);
      try {
        const res = await sendSms(body, valid);
        if (res.ok) {
          toast(`${label}: sent to ${res.sentCount} recipient${res.sentCount !== 1 ? 's' : ''}${skipNote}.`);
        } else if (res.sentCount > 0) {
          toast(`${label}: ${res.sentCount} sent, ${res.failedCount} failed${res.error ? ` — ${res.error}` : ''}.`);
        } else {
          toast(`${label} failed: ${res.error ?? 'unknown error'}`);
        }
        await logComm({
          channel: 'sms', isTest: label.toLowerCase().startsWith('test'), subject: null, body,
          recipientCount: valid.length, sentCount: res.sentCount ?? null, failedCount: res.failedCount ?? null,
          recipients: valid.map((v) => ({ name: v.name ?? '', contact: v.phone })), error: res.ok ? null : (res.error ?? null),
          segments: seg.segments, encoding: seg.encoding, costEstimate: estimateSmsCost(seg.segments, res.sentCount ?? valid.length),
        });
        setLogRefresh((n) => n + 1);
      } catch (e) {
        toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSending(false);
      }
      return;
    }

    const subj = subject.trim();
    if (!subj) { toast('Add a subject before sending.'); return; }
    const valid = people.filter((p) => p.email).map((p) => ({ email: p.email!, name: p.name }));
    if (valid.length === 0) { toast('No recipients have an email address.'); return; }
    if (valid.length > 10 && !window.confirm(`Are you sure you want to send an email message to ${valid.length} people?`)) return;
    setSending(true);
    try {
      const res = await sendEmail(subj, body, valid);
      if (res.ok) {
        toast(`${label}: sent to ${res.sentCount} recipient${res.sentCount !== 1 ? 's' : ''}.`);
      } else if (res.sentCount > 0) {
        toast(`${label}: ${res.sentCount} sent, ${res.failedCount} failed${res.error ? ` — ${res.error}` : ''}.`);
      } else {
        toast(`${label} failed: ${res.error ?? 'unknown error'}`);
      }
      await logComm({
        channel: 'email', isTest: label.toLowerCase().startsWith('test'), subject: subj, body,
        recipientCount: valid.length, sentCount: res.sentCount ?? null, failedCount: res.failedCount ?? null,
        recipients: valid.map((v) => ({ name: v.name ?? '', contact: v.email })), error: res.ok ? null : (res.error ?? null),
      });
      setLogRefresh((n) => n + 1);
    } catch (e) {
      toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  // Rich-text editor ref
  const richRef = useRef<HTMLDivElement>(null);

  const execCmd = useCallback((cmd: string, value?: string) => {
    document.execCommand(cmd, false, value);
    if (richRef.current) {
      setBody(richRef.current.innerHTML);
    }
  }, [setBody]);

  const onRichInput = useCallback(() => {
    if (richRef.current) setBody(richRef.current.innerHTML);
  }, [setBody]);

  // When switching to rich mode, seed the contentEditable with current body
  const switchToRich = () => {
    setEditorMode('rich');
    setPreviewMode(false);
    // Next tick: set innerHTML after the div renders
    setTimeout(() => {
      if (richRef.current) richRef.current.innerHTML = body;
    }, 0);
  };

  const switchToHtml = () => {
    setEditorMode('html');
    // body is already kept in sync via onRichInput
  };

  // Derive the set of manager person IDs from live db.clubs — this picks up
  // managers added/removed during the session without requiring a page reload.
  const managerIdSet = useMemo(
    () => new Set(db.clubs.flatMap((c) => c.managerIds)),
    [db.clubs],
  );

  // memberships are Tier 2 boot-scoped to the caller's own + managed-club
  // rows (whats-next.md §7) — the "with/without membership" audience filter
  // needs every person's status league-wide, so it fetches on demand instead
  // (CONTRACT shape #4). A partial read here isn't just a wrong NUMBER, it's
  // a wrong SEND — "without membership" would wrongly match everyone (and
  // "with" would match no one) if computed before this is ready, so the
  // filter is gated below and the Send button is disabled while it matters.
  const { rows: adminMembershipRows, status: membershipsStatus } = useAdminMemberships();
  const membershipsByPerson = useMemo(() => groupAdminMembershipsByPerson(adminMembershipRows), [adminMembershipRows]);
  const membershipFilterActive = aud.withMembership !== 'any';
  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers the
  // whole league — the audience filter needs everyone, same league-wide
  // shape (#3) as the memberships fetch above and the SAME "wrong SEND, not
  // just a wrong number" stakes: an unfiltered `db.people` (boot-scoped to
  // just the admin's own club, if any) would silently under-address every
  // send. Gated into membershipFilterBlocked below so the Send button stays
  // disabled and recipients stays empty (never wrongly-filtered) until ready.
  const { rows: adminPeopleRows, status: peopleStatus } = useAdminPeople();
  const membershipFilterBlocked = (membershipFilterActive && membershipsStatus !== 'ready') || peopleStatus !== 'ready';

  const recipients = useMemo(() => {
    // The membership filter can't be evaluated correctly until it's loaded —
    // return no recipients rather than a wrongly-filtered set (never send to
    // the wrong list because a fetch hadn't finished yet).
    if (membershipFilterBlocked) return [];
    return adminPeopleRows.filter((p) => {
      const isManager = managerIdSet.has(p.id);
      // Include the person if they match ANY checked audience group. Checking
      // "Club managers" must include a manager regardless of whether they are an
      // athlete or coach — the previous athlete-first exclusion dropped
      // athlete-managers before the manager check ever ran.
      const matchesGroup =
        (aud.athletes && p.kind === 'athlete') ||
        (aud.coaches && p.kind === 'coach') ||
        (aud.managers && isManager);
      if (!matchesGroup) return false;
      const has = (membershipsByPerson.get(p.id) ?? []).some((m) => m.seasonId === season.id && m.status === 'active');
      if (aud.withMembership === 'with' && !has) return false;
      if (aud.withMembership === 'without' && has) return false;
      if (regions.length) {
        const club = db.clubs.find((c) => c.id === p.mainClubId);
        const r = club?.region ?? STATE_REGIONS[p.state] ?? 'Other';
        if (!regions.includes(r)) return false;
      }
      return true;
    });
  }, [adminPeopleRows, db.clubs, managerIdSet, aud, regions, season.id, membershipFilterBlocked, membershipsByPerson]);

  // Club emails for the recipient list
  const clubEmailRows = useMemo(() => {
    if (!aud.clubEmails) return [];
    return db.clubs.filter((c) => c.email).map((c) => ({ name: c.name, email: c.email }));
  }, [db.clubs, aud.clubEmails]);

  // SMS audience is gated on consent + a phone number. Reflect the true size and
  // how many of the matched audience are skipped, so the count isn't misleading.
  const smsAudience = useMemo(() => {
    const withPhone = recipients.filter((p) => p.phone);
    const eligible = partitionByConsent(withPhone).eligible;
    return { eligible: eligible.length, noConsent: withPhone.length - eligible.length, noPhone: recipients.length - withPhone.length };
  }, [recipients]);
  const audienceCount = channel === 'sms' ? smsAudience.eligible : recipients.length + clubEmailRows.length;
  const smsSkipped = smsAudience.noConsent + smsAudience.noPhone;

  // People options for test-send Combo
  // For text-message sends, search/show by phone; for email, by email.
  const peopleOptions = useMemo(() =>
    adminPeopleRows.map((p) => ({
      value: p.id,
      label: `${p.firstName} ${p.lastName}`,
      sub: channel === 'sms' ? (p.phone || '(no phone)') : p.email,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    [adminPeopleRows, channel]
  );

  const addTestPerson = (id: string) => {
    const p = adminPeopleRows.find((x) => x.id === id);
    if (!p || testGroup.some((x) => x.id === id)) return;
    setTestGroup((g) => [...g, p]);
    setTestPersonId(null);
  };

  const removeTestPerson = (id: string) => setTestGroup((g) => g.filter((x) => x.id !== id));

  const sendToAudience = async () => {
    // For SMS the displayed audience is consent-gated; mirror that in the summary.
    const smsRecipients = channel === 'sms' ? partitionByConsent(recipients.filter((p) => p.phone)).eligible : recipients;
    const personRows = (channel === 'sms' ? smsRecipients : recipients).map((p) => ({
      name: `${p.firstName} ${p.lastName}`,
      contact: channel === 'sms' ? p.phone : p.email,
    }));
    const clubRows = channel === 'sms' ? [] : clubEmailRows.map((c) => ({ name: `${c.name} (club email)`, contact: c.email ?? '' }));
    const record: SendRecord = { sentAt: new Date(), channel, recipientCount: personRows.length + clubRows.length, recipients: [...personRows, ...clubRows] };
    setLastSend(record);
    setSendLogExpanded(false);
    const sendRows = [
      ...recipients.map((p) => ({ email: p.email, phone: p.phone, name: `${p.firstName} ${p.lastName}`, smsConsent: p.smsConsent })),
      ...clubEmailRows.map((c) => ({ email: c.email ?? '', name: c.name })),
    ];
    await doSend(sendRows, channel === 'sms' ? 'Text' : 'Email');
  };

  return (
    <div style={{ maxWidth: 920 }}>
      <h1 className="page-title display">Communicate</h1>
      <p className="page-sub">HTML email to filtered groups — built to handle 2,000+ recipients, with event/session targeting.</p>

      <div className="pane-2">
        {/* ---- Left: Audience ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Audience</h3>
          {([['athletes', 'Athletes'], ['coaches', 'Coaches'], ['managers', 'Club managers'], ['clubEmails', 'Club emails']] as const).map(([k, label]) => (
            <label className="checkrow" key={k}>
              <input type="checkbox" checked={aud[k] as boolean} onChange={(e) => setAud({ ...aud, [k]: e.target.checked })} />{label}
            </label>
          ))}
          <Field label="Membership filter">
            <select className="input" value={aud.withMembership} onChange={(e) => setAud({ ...aud, withMembership: e.target.value as typeof aud.withMembership })}>
              <option value="any">With or without membership</option>
              <option value="with">With {season.name} membership</option>
              <option value="without">Without {season.name} membership</option>
            </select>
          </Field>
          <Field label="Regions (multi-select)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
              {allRegions.map((r) => (
                <label className="checkrow" key={r}>
                  <input type="checkbox" checked={regions.includes(r)} onChange={(e) => setRegions(e.target.checked ? [...regions, r] : regions.filter((x) => x !== r))} />{r}
                </label>
              ))}
            </div>
          </Field>

          {/* Recipient count + preview list */}
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span className="stat-big stat-accent" style={{ fontSize: 26 }}>
                {recipients.length + clubEmailRows.length}
              </span>
              <span className="stat-label">recipients</span>
              <button
                className="btn small ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => setListExpanded((v) => !v)}
              >
                {listExpanded ? 'Hide list' : 'See list'}
              </button>
            </div>

            {listExpanded && (
              <div style={{
                marginTop: 8, maxHeight: 240, overflowY: 'auto',
                border: '1px solid var(--line)', borderRadius: 6,
                fontSize: 12.5, background: 'var(--surface-0)',
              }}>
                {recipients.length === 0 && clubEmailRows.length === 0 && (
                  <div style={{ padding: '10px 12px', color: 'var(--ink-soft)' }}>No recipients match the current filters.</div>
                )}
                {recipients.map((p) => {
                  const contact = channel === 'sms' ? ((p as Athlete).phone ?? p.email) : p.email;
                  return (
                    <div key={p.id} style={{ padding: '4px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                      <span>{p.firstName} {p.lastName}</span>
                      <span style={{ color: 'var(--ink-soft)' }}>{contact || <em style={{ opacity: 0.5 }}>no {channel === 'sms' ? 'phone' : 'email'}</em>}</span>
                    </div>
                  );
                })}
                {clubEmailRows.map((c) => (
                  <div key={c.email} style={{ padding: '4px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'space-between', background: 'var(--surface-1)' }}>
                    <span style={{ fontStyle: 'italic' }}>{c.name} (club email)</span>
                    <span style={{ color: 'var(--ink-soft)' }}>{c.email}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---- Right: Message ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Message</h3>

          {/* Channel selector + SMS note */}
          <Field label="Channel">
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}>
              <option value="email">Email (HTML supported)</option>
              <option value="sms">Text message</option>
            </select>
          </Field>
          {channel === 'sms' && (
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: -4, marginBottom: 8, padding: '6px 10px', background: 'var(--surface-1)', borderRadius: 4, borderLeft: '3px solid var(--line)' }}>
              Texts send via Telnyx. Real carrier delivery needs an approved A2P 10DLC campaign —
              until then, test against your own number below. Recipients must have opted in to texts.
            </p>
          )}

          {channel === 'email' && (
            <>
              <Field label="Subject">
                <input
                  className="input"
                  type="text"
                  placeholder="Nationals registration closes Friday!"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>

              {/* Editor mode toggle */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Editor:</span>
                <button
                  className={`btn small ${editorMode === 'html' ? 'primary' : 'ghost'}`}
                  onClick={switchToHtml}
                >HTML</button>
                <button
                  className={`btn small ${editorMode === 'rich' ? 'primary' : 'ghost'}`}
                  onClick={switchToRich}
                >Rich text</button>
                {editorMode === 'html' && (
                  <button
                    className={`btn small ${previewMode ? 'primary' : 'ghost'}`}
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setPreviewMode((v) => !v)}
                  >{previewMode ? 'Edit HTML' : 'Preview'}</button>
                )}
              </div>

              {/* HTML editor or preview */}
              {editorMode === 'html' && (
                previewMode ? (
                  <div
                    style={{
                      minHeight: 160, maxHeight: 340, overflowY: 'auto',
                      border: '1px solid var(--line)', borderRadius: 6,
                      padding: '10px 14px', background: '#fff', color: '#111',
                      fontSize: 14, lineHeight: 1.6,
                    }}
                    // Admin-only internal tool; body is admin-authored HTML
                    dangerouslySetInnerHTML={{ __html: body }}
                  />
                ) : (
                  <textarea
                    className="input"
                    rows={8}
                    style={{ fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical' }}
                    placeholder={'<h1>Hi {{first_name}},</h1>\n<p>…</p>'}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                )
              )}

              {/* Rich-text editor */}
              {editorMode === 'rich' && (
                <div>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                    {([
                      ['Bold', 'bold', '<b>B</b>'],
                      ['Italic', 'italic', '<i>I</i>'],
                      ['Bullets', 'insertUnorderedList', '• List'],
                    ] as const).map(([label, cmd, html]) => (
                      <button
                        key={cmd}
                        className="btn small ghost"
                        style={{ fontFamily: cmd === 'bold' || cmd === 'italic' ? 'inherit' : undefined }}
                        onMouseDown={(e) => { e.preventDefault(); execCmd(cmd); }}
                        dangerouslySetInnerHTML={{ __html: html }}
                        aria-label={label}
                      />
                    ))}
                    <button
                      className="btn small ghost"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const url = window.prompt('Link URL:', 'https://');
                        if (url) execCmd('createLink', url);
                      }}
                    >🔗 Link</button>
                  </div>
                  <div
                    ref={richRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={onRichInput}
                    style={{
                      minHeight: 160, maxHeight: 340, overflowY: 'auto',
                      border: '1px solid var(--line)', borderRadius: 6,
                      padding: '10px 14px', background: '#fff', color: '#111',
                      fontSize: 14, lineHeight: 1.6, outline: 'none',
                    }}
                  />
                  <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 4, marginBottom: 0 }}>
                    Tip: you can switch to HTML mode to see or edit the generated markup.
                  </p>
                </div>
              )}
            </>
          )}

          {channel === 'sms' && (() => {
            const seg = analyzeMessage(body);
            return (
              <Field label="Message">
                <textarea
                  className="input"
                  rows={4}
                  maxLength={612}
                  placeholder="UCG: Reg closes Friday. Pay at the portal. Reply STOP to opt out."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 12, color: 'var(--ink-soft)' }}>
                  <span>{seg.length} chars · {seg.encoding}</span>
                  <span style={{ color: seg.segments > 1 ? 'var(--warn)' : 'var(--ink-soft)' }}>
                    {seg.segments} segment{seg.segments !== 1 ? 's' : ''}
                  </span>
                  {seg.isUnicode && (
                    <>
                      <span style={{ color: 'var(--warn)' }}>
                        ⚠ Unicode — limit drops to 70/segment
                      </span>
                      <button
                        type="button"
                        className="btn small ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setBody((b) => normalizeToGsm7(b))}
                      >Normalize</button>
                    </>
                  )}
                </div>
              </Field>
            );
          })()}

          {/* From sender info */}
          <div style={{ margin: '12px 0 8px', padding: '8px 12px', background: 'var(--surface-1)', borderRadius: 4, fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {channel === 'sms' ? (
              <>
                <strong style={{ color: 'var(--ink)' }}>From:</strong> UCG Telnyx number
                <span style={{ marginLeft: 8 }}>— test-grade. STOP/HELP handled automatically by the carrier.</span>
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--ink)' }}>From:</strong> United Club Gymnastics &lt;nate.sharpe@naigc.org&gt;
                <span style={{ marginLeft: 8 }}>— test sender (Gmail SMTP). Production sender (Resend/Workspace) TBD.</span>
              </>
            )}
          </div>

        </div>
      </div>

      {/* ---- Send card (separate from Audience/Message so it's clear this is the
              real send, not the test) — with the last-send summary at the bottom ---- */}
      <div className="pane-2" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <h3 className="card-title">Send to selected audience</h3>
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
            Sends the composed {channel === 'sms' ? 'text message' : 'email'} to the{' '}
            {audienceCount} recipient{audienceCount !== 1 ? 's' : ''}{' '}
            matching your Audience filters{channel === 'sms' ? ' who have opted in to SMS' : ''}.
          </p>
          {membershipFilterBlocked && (
            <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Loading the audience list…</p>
          )}
          <button
            className="btn primary"
            disabled={sending || audienceCount === 0 || membershipFilterBlocked}
            onClick={sendToAudience}
          >
            {sending ? 'Sending…' : `Send to ${audienceCount} →`}
          </button>
          {channel === 'sms' && smsSkipped > 0 && (
            <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>
              {smsSkipped} matched recipient{smsSkipped !== 1 ? 's' : ''} skipped
              {smsAudience.noConsent > 0 ? ` — ${smsAudience.noConsent} not opted in` : ''}
              {smsAudience.noPhone > 0 ? `${smsAudience.noConsent > 0 ? ',' : ' —'} ${smsAudience.noPhone} without a phone` : ''}.
            </p>
          )}
          {channel === 'sms' && (
            <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>Live delivery requires an approved 10DLC campaign.</p>
          )}

          {/* Last send summary — bottom of the send card */}
          {lastSend && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Last send — {lastSend.channel === 'sms' ? 'Text' : 'Email'} to{' '}
                  <span style={{ color: 'var(--teal-900)' }}>{lastSend.recipientCount} recipient{lastSend.recipientCount !== 1 ? 's' : ''}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                  {lastSend.sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                  {lastSend.sentAt.toLocaleDateString()}
                </span>
                <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => setSendLogExpanded((v) => !v)}>
                  {sendLogExpanded ? 'Hide' : 'Show list'}
                </button>
              </div>
              {sendLogExpanded && (
                <div style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12.5, background: 'var(--surface-0)' }}>
                  {lastSend.recipients.map((r, i) => (
                    <div key={i} style={{ padding: '4px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                      <span>{r.name}</span>
                      <span style={{ color: 'var(--ink-soft)' }}>{r.contact || <em style={{ opacity: 0.5 }}>—</em>}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---- Test send card (next to the real send) ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Send test {channel === 'sms' ? 'text message' : 'email'}</h3>
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
            Sends the same composed message to specific people you pick — these need not match the
            audience filters.
          </p>
          <Field label="Add person to test group">
            <Combo
              options={peopleOptions}
              value={testPersonId}
              onChange={addTestPerson}
              placeholder={`Search by name or ${channel === 'sms' ? 'phone' : 'email'}…`}
            />
          </Field>

          {testGroup.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {testGroup.map((p) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: 13.5 }}>
                  <span>{p.firstName} {p.lastName} <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{channel === 'sms' ? (p.phone || '(no phone)') : p.email}</span></span>
                  <button className="btn small ghost" onClick={() => removeTestPerson(p.id)}>✕</button>
                </div>
              ))}
            </div>
          )}

          <button
            className="btn ghost"
            disabled={testGroup.length === 0 || sending}
            onClick={() => doSend(
              testGroup.map((p) => ({ email: p.email, phone: p.phone, name: `${p.firstName} ${p.lastName}`, smsConsent: p.smsConsent })),
              channel === 'sms' ? 'Test text' : 'Test email',
            )}
          >
            {sending ? 'Sending…' : `Send test to ${testGroup.length} selected`}
          </button>
        </div>
      </div>

      {/* ---- Communication history (persistent log) ---- */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 className="card-title" style={{ margin: 0 }}>Communication history</h3>
          <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => setHistoryOpen((v) => !v)}>
            {historyOpen ? 'Hide' : 'Show'}
          </button>
        </div>
        {historyOpen && (
          commLog.length === 0 ? (
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 10 }}>No sends recorded yet.</p>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {commLog.map((c) => {
                const open = expandedLogId === c.id;
                const when = new Date(c.sentAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const ok = (c.failedCount ?? 0) === 0 && !c.error;
                return (
                  <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }}
                      onClick={() => setExpandedLogId(open ? null : c.id)}>
                      <Badge tone={c.channel === 'sms' ? 'navy' : 'info'}>{c.channel === 'sms' ? 'Text' : 'Email'}</Badge>
                      {c.isTest && <Badge tone="warn">Test</Badge>}
                      <span style={{ fontSize: 13 }}>{when}</span>
                      <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                        {c.recipientCount} recipient{c.recipientCount !== 1 ? 's' : ''}
                        {c.sentCount != null && ` · ${c.sentCount} sent${c.failedCount ? `, ${c.failedCount} failed` : ''}`}
                      </span>
                      <Badge tone={ok ? 'ok' : 'err'}>{ok ? 'Sent' : 'Issues'}</Badge>
                      <button
                        type="button"
                        className="linklike-button"
                        aria-expanded={open}
                        style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--teal-900)' }}
                        onClick={(e) => { e.stopPropagation(); setExpandedLogId(open ? null : c.id); }}
                      >
                        {open ? 'Hide' : 'Details'}
                      </button>
                    </div>
                    {open && (
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        {c.subject && <div style={{ marginBottom: 4 }}><strong>Subject:</strong> {c.subject}</div>}
                        {c.channel === 'sms' && c.segments != null && (
                          <div style={{ marginBottom: 4, color: 'var(--ink-soft)' }}>
                            {c.segments} segment{c.segments !== 1 ? 's' : ''}{c.encoding ? ` · ${c.encoding}` : ''}
                            {c.costEstimate != null ? ` · est. $${c.costEstimate.toFixed(c.costEstimate < 1 ? 4 : 2)}` : ''}
                          </div>
                        )}
                        {c.error && <div style={{ color: 'var(--coral-text)', marginBottom: 4 }}>Error: {c.error}</div>}
                        <details style={{ marginBottom: 6 }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--ink-soft)' }}>Message</summary>
                          <div style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 4, padding: 8, marginTop: 4, fontSize: 12.5 }}>{c.body}</div>
                        </details>
                        <details>
                          <summary style={{ cursor: 'pointer', color: 'var(--ink-soft)' }}>Recipients ({c.recipients.length})</summary>
                          <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
                            {c.recipients.map((r, i) => (
                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0', fontSize: 12.5 }}>
                                <span>{r.name || '—'}</span><span style={{ color: 'var(--ink-soft)' }}>{r.contact}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* ---- Text activity: inbound replies + per-message delivery status ---- */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 className="card-title" style={{ margin: 0 }}>Text activity</h3>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>inbound replies &amp; delivery status</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {smsActivityOpen && (
              <button className="btn small ghost" disabled={smsLoading} onClick={refreshSmsActivity}>Refresh</button>
            )}
            <button className="btn small ghost" onClick={openSmsActivity}>{smsActivityOpen ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        {smsActivityOpen && (
          smsLoading ? (
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 10 }}>Loading…</p>
          ) : smsMessages.length === 0 ? (
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 10 }}>
              No text activity yet. Inbound replies and delivery receipts appear here once Telnyx delivers them
              (requires the approved 10DLC campaign).
            </p>
          ) : (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Inbound replies */}
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>Replies ({inboundMsgs.length})</h4>
                {inboundMsgs.length === 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>No inbound replies.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {inboundMsgs.map((m) => (
                      <div key={m.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                          <Badge tone="navy">In</Badge>
                          <strong style={{ fontSize: 13 }}>{m.phone}</strong>
                          <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                            {new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, marginTop: 4, color: 'var(--ink)' }}>{m.body || '—'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Outbound delivery status */}
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>Delivery status ({outboundMsgs.length})</h4>
                {outboundMsgs.length === 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>No outbound messages tracked.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {outboundMsgs.map((m) => {
                      const cls = classifyDeliveryStatus(m.status);
                      const tone = cls === 'delivered' ? 'ok' : cls === 'failed' ? 'err' : 'warn';
                      return (
                        <div key={m.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
                          <Badge tone={tone}>{m.status || cls}</Badge>
                          <span>{m.phone}</span>
                          <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                            {new Date(m.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {m.error && <span style={{ fontSize: 12, color: 'var(--coral-text)' }}>{m.error}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
