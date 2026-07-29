import { useState } from 'react';
import { useDB, mutate } from '../../../lib/store';
import { Badge, Combo, Field } from '../../../components/ui';
import { useToast } from '../../../components/ui-hooks';
import type { Coupon } from '../../../lib/types';
import { fmtMoney } from '../../../lib/scoring';
import { randomPromoCode, couponValid } from '../../../lib/pricing';
import { pushCoupon, deleteCoupon } from '../../../lib/supabase';
import { useAdminPeople } from '../../../lib/people-admin-slice';

// ---------- Promo codes (W14) ----------
type CouponDraft = {
  code: string;
  discountType: 'pct' | 'amt';
  value: string;
  appliesTo: Coupon['appliesTo'];
  /** Only used when appliesTo === 'meet-entry': which future event this code
   *  is scoped to (it hard-expires once that event ends). */
  appliesToEventId: string | null;
  // W14 task 9: new fields
  startsAt: string;
  endsAt: string;
  maxUses: string; // blank = unlimited
  restrictAccount: boolean;
  restrictedToPersonId: string | null;
};

// W14 task 11: inline validity indicator using couponValid()
export function CouponStatusBadge({ coupon }: { coupon: Coupon }) {
  const db = useDB();
  const now = new Date().toISOString();
  const scopedEvent = coupon.appliesToEventId ? db.events.find((m) => m.id === coupon.appliesToEventId) : undefined;
  const valid = couponValid(coupon, now, scopedEvent?.endDate);
  if (!valid) {
    if (coupon.maxUses != null && (coupon.usedCount ?? 0) >= coupon.maxUses) {
      return <Badge tone="err">Limit reached</Badge>;
    }
    if (scopedEvent && Date.parse(scopedEvent.endDate) + 86400000 < Date.parse(now)) {
      return <Badge tone="err">Event ended</Badge>;
    }
    if (coupon.endsAt && Date.parse(coupon.endsAt) < Date.parse(now)) {
      return <Badge tone="err">Expired</Badge>;
    }
    if (coupon.startsAt && Date.parse(coupon.startsAt) > Date.parse(now)) {
      return <Badge tone="warn">Not yet active</Badge>;
    }
    return <Badge tone="err">Invalid</Badge>;
  }
  return <Badge tone="ok">Active</Badge>;
}

type CouponEditDraft = {
  startsAt: string;
  endsAt: string;
  maxUses: string;
};

export function Promos() {
  const db = useDB();
  const toast = useToast();
  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers the
  // whole league — the "restricted to account" picker and its display need
  // any account league-wide, same shape (#3) as every other admin-only
  // whole-league surface.
  const { rows: adminPeopleRows } = useAdminPeople();
  const [draft, setDraft] = useState<CouponDraft>({
    code: '', discountType: 'pct', value: '', appliesTo: 'any', appliesToEventId: null,
    startsAt: '', endsAt: '', maxUses: '', restrictAccount: false, restrictedToPersonId: null,
  });
  // Only future events (by end date) can be picked — a code scoped to a past
  // event would be dead on arrival, and this list IS the "Applies to" dropdown
  // requirement (a coupon can target one specific upcoming event).
  const todayISO = new Date().toISOString().slice(0, 10);
  const futureEvents = db.events.filter((m) => m.endDate >= todayISO).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // W14 task 9: inline edit state per coupon (code → draft)
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<CouponEditDraft>({ startsAt: '', endsAt: '', maxUses: '' });

  const addCoupon = () => {
    const code = draft.code.trim().toUpperCase();
    if (!code) { toast('Code is required.'); return; }
    if (db.coupons.some((c) => c.code.toUpperCase() === code)) { toast(`Code "${code}" already exists.`); return; }
    const value = parseFloat(draft.value);
    if (isNaN(value) || value <= 0) { toast('Discount value must be a positive number.'); return; }
    if (draft.discountType === 'pct' && value > 100) { toast('Percent off must be between 0 and 100.'); return; }
    const maxUses = draft.maxUses.trim() === '' ? null : parseInt(draft.maxUses, 10);
    if (draft.maxUses.trim() !== '' && (isNaN(maxUses as number) || (maxUses as number) < 1)) {
      toast('Max uses must be a positive integer or blank for unlimited.'); return;
    }
    if (draft.restrictAccount && !draft.restrictedToPersonId) { toast('Pick the account this code is restricted to, or uncheck the restriction.'); return; }
    if (draft.appliesTo === 'meet-entry' && !draft.appliesToEventId) { toast('Pick which event this code applies to.'); return; }
    const coupon: Coupon = {
      code,
      ...(draft.discountType === 'pct' ? { pctOff: value } : { amountOff: value }),
      appliesTo: draft.appliesTo,
      appliesToEventId: draft.appliesTo === 'meet-entry' ? draft.appliesToEventId : null,
      startsAt: draft.startsAt || null,
      endsAt: draft.endsAt || null,
      maxUses: maxUses ?? null,
      usedCount: 0,
      restrictedToPersonId: draft.restrictAccount ? draft.restrictedToPersonId : null,
    };
    if (!mutate((d) => { d.coupons.push(coupon); pushCoupon(coupon); })) return; // offline read-only gate
    setDraft({ code: '', discountType: 'pct', value: '', appliesTo: 'any', appliesToEventId: null, startsAt: '', endsAt: '', maxUses: '', restrictAccount: false, restrictedToPersonId: null });
    toast(`Promo code "${code}" created.`);
  };

  const removeCoupon = (code: string) => {
    if (!mutate((d) => { d.coupons = d.coupons.filter((c) => c.code !== code); })) return; // offline read-only gate
    deleteCoupon(code);
    setConfirmDelete(null);
    toast(`Deleted promo code "${code}".`);
  };

  const startEdit = (c: Coupon) => {
    setEditingCode(c.code);
    setEditDraft({
      startsAt: c.startsAt ?? '',
      endsAt: c.endsAt ?? '',
      maxUses: c.maxUses == null ? '' : String(c.maxUses),
    });
  };

  const saveEdit = (c: Coupon) => {
    const maxUses = editDraft.maxUses.trim() === '' ? null : parseInt(editDraft.maxUses, 10);
    if (editDraft.maxUses.trim() !== '' && (isNaN(maxUses as number) || (maxUses as number) < 1)) {
      toast('Max uses must be a positive integer or blank for unlimited.'); return;
    }
    const applied = mutate((d) => {
      const x = d.coupons.find((x) => x.code === c.code);
      if (!x) return;
      x.startsAt = editDraft.startsAt || null;
      x.endsAt = editDraft.endsAt || null;
      x.maxUses = maxUses ?? null;
      pushCoupon(x);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    setEditingCode(null);
    toast(`Promo code "${c.code}" updated.`);
  };

  return (
    <div>
      <div className="card card-pad" style={{ maxWidth: 560, marginBottom: 20 }}>
        <h3 className="card-title">Create promo code</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <Field label="Code">
              <input
                className="input"
                placeholder="e.g. SAVE20"
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>
          {/* W14 task 10: Generate random code button */}
          <button
            className="btn ghost"
            style={{ marginBottom: 16 }}
            onClick={() => setDraft({ ...draft, code: randomPromoCode() })}
            title="Generate a random 8-character code"
          >
            Random code
          </button>
        </div>
        <Field label="Discount type">
          <select
            className="input"
            value={draft.discountType}
            onChange={(e) => setDraft({ ...draft, discountType: e.target.value as CouponDraft['discountType'] })}
          >
            <option value="pct">Percent off (%)</option>
            <option value="amt">Amount off ($)</option>
          </select>
        </Field>
        <Field label={draft.discountType === 'pct' ? 'Percent off' : 'Amount off ($)'}>
          <input
            className="input"
            type="number"
            min={0}
            step={draft.discountType === 'pct' ? 1 : 0.01}
            max={draft.discountType === 'pct' ? 100 : undefined}
            placeholder={draft.discountType === 'pct' ? 'e.g. 20' : 'e.g. 10.00'}
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          />
        </Field>
        <Field label="Applies to">
          <select
            className="input"
            value={draft.appliesTo}
            onChange={(e) => setDraft({
              ...draft,
              appliesTo: e.target.value as Coupon['appliesTo'],
              appliesToEventId: e.target.value === 'meet-entry' ? draft.appliesToEventId : null,
            })}
          >
            <option value="any">Any purchase</option>
            <option value="athlete-membership">Athlete Membership</option>
            <option value="club-membership">Club Membership</option>
            <option value="coach-membership">Coach Membership</option>
            <option value="meet-entry">A specific event</option>
          </select>
        </Field>
        {draft.appliesTo === 'meet-entry' && (
          <Field label="Which event?" hint="Hard-expires the day after this event ends, regardless of the expiration date below.">
            <select
              className="input"
              value={draft.appliesToEventId ?? ''}
              onChange={(e) => setDraft({ ...draft, appliesToEventId: e.target.value || null })}
            >
              <option value="" disabled>Select an event…</option>
              {futureEvents.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.startDate})</option>)}
            </select>
          </Field>
        )}
        {/* W14 task 9: start/end dates and max uses on creation */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Active from (optional)">
            <input
              className="input"
              type="datetime-local"
              value={draft.startsAt}
              onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
            />
          </Field>
          <Field label="Expires at (optional)">
            <input
              className="input"
              type="datetime-local"
              value={draft.endsAt}
              onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Max uses (blank = unlimited)">
          <input
            className="input"
            type="number"
            min={1}
            step={1}
            placeholder="Unlimited"
            value={draft.maxUses}
            onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })}
          />
        </Field>
        <label className="checkrow" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={draft.restrictAccount}
            onChange={(e) => setDraft({ ...draft, restrictAccount: e.target.checked, restrictedToPersonId: e.target.checked ? draft.restrictedToPersonId : null })} />
          Only usable by a specific account?
        </label>
        {draft.restrictAccount && (
          <Field label="Restricted to account">
            <Combo
              options={adminPeopleRows.map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}`, sub: p.email })).sort((a, b) => a.label.localeCompare(b.label))}
              value={draft.restrictedToPersonId}
              onChange={(v) => setDraft({ ...draft, restrictedToPersonId: v })}
              placeholder="Search by name or email…"
            />
          </Field>
        )}
        <button className="btn primary" onClick={addCoupon}>Create code</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Code</th>
              <th>Discount</th>
              <th>Applies to</th>
              {/* W14 task 9: new columns */}
              <th>Active from</th>
              <th>Expires</th>
              <th className="num">Uses</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {db.coupons.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--ink-soft)', padding: '20px 0' }}>No promo codes yet.</td></tr>
            )}
            {db.coupons.map((c) => {
              const isEditing = editingCode === c.code;
              return (
                <tr key={c.code}>
                  <td>
                    <strong style={{ fontFamily: 'monospace' }}>{c.code}</strong>
                    {c.restrictedToPersonId && (() => {
                      const p = adminPeopleRows.find((x) => x.id === c.restrictedToPersonId);
                      return <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-soft)' }} data-tip="Only this account can redeem this code">🔒 {p ? `${p.firstName} ${p.lastName}` : 'specific account'}</span>;
                    })()}
                  </td>
                  <td>
                    {c.pctOff != null ? `${c.pctOff}% off` : c.amountOff != null ? `${fmtMoney(c.amountOff)} off` : '—'}
                  </td>
                  <td>
                    {c.appliesTo === 'any' ? 'Any purchase'
                      : c.appliesTo === 'athlete-membership' ? 'Athlete Membership'
                      : c.appliesTo === 'club-membership' ? 'Club Membership'
                      : c.appliesTo === 'coach-membership' ? 'Coach Membership'
                      : c.appliesTo === 'membership' ? 'Membership (any type)'
                      : c.appliesToEventId
                        ? (db.events.find((m) => m.id === c.appliesToEventId)?.name ?? 'Event (deleted)')
                        : 'Event entries'}
                  </td>
                  {/* W14 task 9: editable start/end/maxUses */}
                  {isEditing ? (
                    <>
                      <td>
                        <input
                          className="input"
                          type="datetime-local"
                          style={{ fontSize: 12, width: 160 }}
                          value={editDraft.startsAt}
                          onChange={(e) => setEditDraft({ ...editDraft, startsAt: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="datetime-local"
                          style={{ fontSize: 12, width: 160 }}
                          value={editDraft.endsAt}
                          onChange={(e) => setEditDraft({ ...editDraft, endsAt: e.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="input"
                          type="number"
                          min={1}
                          step={1}
                          placeholder="∞"
                          style={{ width: 60 }}
                          value={editDraft.maxUses}
                          onChange={(e) => setEditDraft({ ...editDraft, maxUses: e.target.value })}
                        />
                      </td>
                      <td><CouponStatusBadge coupon={c} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small primary" onClick={() => saveEdit(c)}>Save</button>{' '}
                        <button className="btn small ghost" onClick={() => setEditingCode(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ fontSize: 12.5 }}>{c.startsAt ? new Date(c.startsAt).toLocaleString() : <em style={{ color: 'var(--ink-soft)' }}>—</em>}</td>
                      <td style={{ fontSize: 12.5 }}>{c.endsAt ? new Date(c.endsAt).toLocaleString() : <em style={{ color: 'var(--ink-soft)' }}>—</em>}</td>
                      {/* W14 task 9: show used count / max */}
                      <td className="num" style={{ fontSize: 13 }}>
                        {c.usedCount ?? 0}{c.maxUses != null ? ` / ${c.maxUses}` : ''}
                      </td>
                      {/* W14 task 11: validity status via couponValid() */}
                      <td><CouponStatusBadge coupon={c} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small ghost" onClick={() => startEdit(c)}>Edit</button>{' '}
                        {confirmDelete === c.code ? (
                          <>
                            <span style={{ fontSize: 13, marginRight: 4 }}>Delete?</span>
                            <button className="btn small danger" onClick={() => removeCoupon(c.code)}>Yes</button>{' '}
                            <button className="btn small ghost" onClick={() => setConfirmDelete(null)}>No</button>
                          </>
                        ) : (
                          <button className="btn small ghost" onClick={() => setConfirmDelete(c.code)}>Delete</button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
