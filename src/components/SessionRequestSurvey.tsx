import { useState } from 'react';
import { Field } from './ui';
import { mutate } from '../lib/store';
import { pushSessionRequest } from '../lib/supabase';
import { SESSION_REQUEST_ARRIVAL_OPTIONS, sessionRequestAnswered } from '../lib/pricing';
import type { SessionRequestKey } from '../lib/pricing';
import type { EventSession, SessionRequest, SessionRequestAnswers } from '../lib/types';

/** Exactly one of `clubId`/`personId` — mirrors `SessionRequest`'s own dual
 *  scoping (club variant vs. independent-athlete variant). */
export type SessionRequestOwner = { clubId: string; personId?: undefined } | { clubId?: undefined; personId: string };

/**
 * Nationals session-planning survey card (event-mgmt v2 Phase 5, A2, spec
 * §L.1/§E5.4): one row per required `SessionRequestKey` (one per registered
 * WAG level + combined MAG/T&T for the club variant; one per discipline for
 * the independent variant — see `requiredSessionRequests`, `pricing.ts`).
 * Renders nothing when `keys` is empty (non-nationals event, or nothing
 * registered yet requiring a survey).
 */
export function SessionRequestSurveyCard({
  eventId, sessions, keys, existing, owner, editable, showSeparateGyms, notesHint, labelFor,
}: {
  eventId: string;
  sessions: EventSession[];
  keys: SessionRequestKey[];
  existing: SessionRequest[];
  owner: SessionRequestOwner;
  editable: boolean;
  showSeparateGyms: boolean;
  notesHint?: string;
  labelFor: (key: SessionRequestKey) => string;
}) {
  if (keys.length === 0) return null;
  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Nationals session-planning survey</h3>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
        {editable
          ? 'Help us plan sessions — answers can be updated any time before the edit deadline.'
          : 'Answers are read-only — this event’s edit deadline has passed.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {keys.map((key) => (
          <SurveyRow
            key={`${key.discipline}-${key.levelId ?? 'combined'}`}
            eventId={eventId}
            sessions={sessions}
            keyDef={key}
            existing={existing.find((r) => r.discipline === key.discipline && (r.levelId ?? null) === key.levelId)}
            owner={owner}
            editable={editable}
            showSeparateGyms={showSeparateGyms}
            notesHint={notesHint}
            label={labelFor(key)}
          />
        ))}
      </div>
    </div>
  );
}

// Kept at module scope (not nested in SessionRequestSurveyCard's render) so
// each row owns its own draft state independently.
function SurveyRow({
  eventId, sessions, keyDef, existing, owner, editable, showSeparateGyms, notesHint, label,
}: {
  eventId: string;
  sessions: EventSession[];
  keyDef: SessionRequestKey;
  existing?: SessionRequest;
  owner: SessionRequestOwner;
  editable: boolean;
  showSeparateGyms: boolean;
  notesHint?: string;
  label: string;
}) {
  const [draft, setDraft] = useState<SessionRequestAnswers>(() => existing?.answers ?? {});
  const [saved, setSaved] = useState(!!existing && sessionRequestAnswered(existing.answers));
  const answered = sessionRequestAnswered(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(existing?.answers ?? {});

  const toggleSession = (sessionId: string) => {
    setDraft((d) => {
      const cur = d.preferredSessionIds ?? [];
      const next = cur.includes(sessionId) ? cur.filter((id) => id !== sessionId) : [...cur, sessionId];
      return { ...d, preferredSessionIds: next };
    });
  };

  const save = () => {
    const id = existing?.id ?? crypto.randomUUID();
    const row: SessionRequest = {
      id,
      eventId,
      discipline: keyDef.discipline,
      levelId: keyDef.levelId,
      ...(owner.clubId ? { clubId: owner.clubId, personId: null } : { personId: owner.personId, clubId: null }),
      answers: draft,
      updatedAt: new Date().toISOString(),
    };
    mutate((d) => {
      const list = d.sessionRequests ?? (d.sessionRequests = []);
      const idx = list.findIndex((r) => r.id === id);
      if (idx >= 0) list[idx] = row; else list.push(row);
      pushSessionRequest(row);
    });
    setSaved(true);
  };

  return (
    <div style={{ paddingTop: 10, borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>{label}</strong>
        {answered
          ? <span style={{ fontSize: 12, color: 'var(--ok-600, #16803c)' }}>✓ Answered</span>
          : <span style={{ fontSize: 12, color: 'var(--warn-600, #b45309)' }}>Needs answer</span>}
      </div>

      <div className="grid cols-2" style={{ gap: 12 }}>
        <Field label="Arrival" required>
          <select
            className="input"
            value={draft.arrival ?? ''}
            disabled={!editable}
            onChange={(e) => setDraft((d) => ({ ...d, arrival: e.target.value }))}
          >
            <option value="" disabled>— select —</option>
            {SESSION_REQUEST_ARRIVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>

        {showSeparateGyms && (
          <Field label="Split across separate gyms/podiums?">
            <select
              className="input"
              value={draft.separateGyms === true ? 'yes' : draft.separateGyms === false ? 'no' : ''}
              disabled={!editable}
              onChange={(e) => setDraft((d) => ({
                ...d,
                separateGyms: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null,
              }))}
            >
              <option value="">No preference</option>
              <option value="yes">Yes, split across gyms</option>
              <option value="no">No, keep together</option>
            </select>
          </Field>
        )}
      </div>

      {sessions.length > 0 && (
        <Field label="Preferred sessions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {sessions.map((s) => (
              <label key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={(draft.preferredSessionIds ?? []).includes(s.id)}
                  disabled={!editable}
                  onChange={() => toggleSession(s.id)}
                />
                {s.name}
              </label>
            ))}
          </div>
        </Field>
      )}

      <Field label="Notes (optional)" hint={notesHint}>
        <textarea
          className="input"
          rows={2}
          value={draft.notes ?? ''}
          disabled={!editable}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
        />
      </Field>

      {editable && (
        <button className="btn ghost small" style={{ marginTop: 6 }} onClick={save} disabled={!dirty && saved}>
          Save answers
        </button>
      )}
    </div>
  );
}
