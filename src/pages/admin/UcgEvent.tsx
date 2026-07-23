import { useState } from 'react';
import { useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import { useDB } from '../../lib/store';
import { useFmtDate } from '../../components/ui-hooks';
import { EventWizard } from '../../components/EventWizard';
import { flipfestTemplate, nationalsTemplate, findUcgEvent } from '../../lib/ucg-event-templates';
import type { Event } from '../../lib/types';

const LABEL: Record<'flipfest' | 'nationals', string> = { flipfest: 'FlipFest', nationals: 'UCG Nationals' };

// Extracted so this button's own `open` state doesn't force the whole page
// (and the `findUcgEvent` lookup) to re-render on every EventWizard keystroke.
// FlipFest only — Nationals edits full-page via `UcgEvent`'s own state below
// (PM feedback 2026-07-22 §A: the wizard needs the full page, not a card slot).
// `initialEdit` opens the wizard immediately — used when the event detail
// page's "Edit event" button navigates here with router state
// `{ edit: true }` (feedback-2 §5: UCG events skip the overlay wizard in
// favor of this full-page admin editor).
function EditDetailsButton({ event, initialEdit }: { event: Event; initialEdit?: boolean }) {
  const [open, setOpen] = useState(!!initialEdit);
  return (
    <>
      <button className="btn primary" onClick={() => setOpen(true)}>Edit details</button>
      {open && <EventWizard editEvent={event} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Dedicated admin page for a season's UCG-hosted event instance (FlipFest
 *  camp or Nationals championship) — spec 2026-07-20 §FlipFest/Nationals
 *  model. Reached from the Seasons & fees table's Create/Edit buttons
 *  (`Seasons.tsx`). No instance yet → the EventWizard opens immediately,
 *  prefilled from the template, and SAVES AS CREATE. An instance already
 *  exists → a compact summary card with a link to "Edit details". */
export function UcgEvent() {
  const { template: templateParam, seasonId } = useParams<{ template: string; seasonId: string }>();
  const db = useDB();
  const navigate = useNavigate();
  const location = useLocation();
  const fmtDate = useFmtDate();
  // Arriving via the event detail page's "Edit event" button (feedback-2
  // §5) passes router state `{ edit: true }` — open the editor immediately
  // rather than landing on the summary card first.
  const openImmediately = !!(location.state as { edit?: boolean } | null)?.edit;
  // Nationals "Edit details" renders EventWizard full-page (PM feedback
  // 2026-07-22 §A) — tracked here so the summary card is replaced entirely
  // rather than the wizard squeezing in beside it.
  const [editingNationals, setEditingNationals] = useState(openImmediately);

  const which = templateParam === 'flipfest' || templateParam === 'nationals' ? templateParam : null;
  const season = db.seasons.find((s) => s.id === seasonId) ?? null;

  if (!which || !season) {
    return (
      <div>
        <h1 className="page-title display">UCG Event</h1>
        <p className="page-sub">
          {!which ? `Unknown UCG-event template "${templateParam}".` : `No season found for id "${seasonId}".`}
        </p>
        <Link className="btn ghost" to="/admin/league">← Back to League Controls</Link>
      </div>
    );
  }

  const existing = findUcgEvent(db, season, which);

  if (!existing) {
    const template = which === 'flipfest' ? flipfestTemplate(season, db) : nationalsTemplate(season, db);
    return (
      <EventWizard
        template={template}
        variant={which === 'nationals' ? 'page' : 'modal'}
        onClose={() => navigate('/admin/league')}
      />
    );
  }

  if (which === 'nationals' && editingNationals) {
    return <EventWizard editEvent={existing} variant="page" onClose={() => setEditingNationals(false)} />;
  }

  return (
    <div>
      <h1 className="page-title display">{LABEL[which]} — {season.name}</h1>
      <div className="card card-pad" style={{ maxWidth: 560 }}>
        <h3 className="card-title" style={{ marginTop: 0 }}>{existing.name}</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
          {existing.startDate === existing.endDate
            ? fmtDate(existing.startDate)
            : `${fmtDate(existing.startDate)} – ${fmtDate(existing.endDate)}`}
          {' · '}Registration {fmtDate(existing.regOpens.slice(0, 10))} – {fmtDate(existing.regCloses.slice(0, 10))}
        </p>
        {which === 'nationals' && (
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>
            Heavy configuration (qualification cutoffs, finals levels, add-ons) lives on the event's own
            admin surfaces — open the <Link to={`/events/${existing.slug}`}>public event page</Link> to get there.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <Link className="btn" to={`/events/${existing.slug}`}>View public event page</Link>
          {which === 'nationals'
            ? <button className="btn primary" onClick={() => setEditingNationals(true)}>Edit details</button>
            : <EditDetailsButton event={existing} initialEdit={openImmediately} />}
          <Link className="btn ghost" to="/admin/league">← Back to League Controls</Link>
        </div>
      </div>
    </div>
  );
}
