import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useToast } from '../components/ui-hooks';
import { Combo } from '../components/ui';
import { useClubRegistrations } from '../lib/registrations-slice';
import { cleanupCrossClubCart } from '../lib/cart-sync';
import { setCurrentClubId } from '../lib/current-club';
import { CartScope, ReceiptsSection } from './Cart';

/** Club Cart (UAT round-1, Z-01-02/M-01-04/M-19-01): a real page now — was a
 *  bare `<Navigate to="/cart" replace>` redirect (registrations-and-camps.md's
 *  retired-routes note), which meant a club's cart/receipts could ONLY be
 *  reached bundled onto the manager's own personal /cart page — easy to
 *  mistake one entity's money for the other's (Z-01-02), and impossible for a
 *  manager of MULTIPLE clubs, or a league admin, to view any club but every
 *  one of them at once. This page shows exactly ONE club's cart + full
 *  receipts history, with the same club-switcher idiom as Club.tsx
 *  (`switchableClubs` + `Combo`). */
export function ClubCartPage() {
  const { clubId } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const receiptsRef = useRef<HTMLDivElement>(null);
  const [removedNotices, setRemovedNotices] = useState<string[]>([]);

  const club = db.clubs.find((c) => c.id === clubId);
  const canManage = !!club && (caps.isAdmin || caps.managedClubIds.includes(club.id));

  // Keep the nav's "My Club" links pointed at whichever club is actually
  // being viewed (current-club.ts) — mirrors the same effect on ClubPage.
  useEffect(() => {
    if (club && canManage) setCurrentClubId(club.id);
  }, [club, canManage]);

  useEffect(() => { window.scrollTo(0, 0); }, []);

  // Cross-club cart cleanup (3d), moved here from the retired ManagedClubSection
  // (Cart.tsx) — still routed through the same shared `cleanupCrossClubCart`,
  // but the toast callback ALSO appends a persistent on-page notice (UAT
  // M-01-04, "Jurassic's cart vanished"): a toast alone auto-dismisses and is
  // easy to miss, which is exactly how a manager lost track of why a line
  // disappeared. Gated on 'ready' (Phase 3 completeness — see cart-sync.ts).
  const clubRegsAllEvents = useClubRegistrations(club?.id ?? null);
  useEffect(() => {
    if (!club || clubRegsAllEvents.status !== 'ready') return;
    cleanupCrossClubCart(db, clubRegsAllEvents.rows, club.id, (msg, opts) => {
      toast(msg, opts);
      setRemovedNotices((prev) => [...prev, msg]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, club?.id, clubRegsAllEvents.status]);

  if (!club) return <p>Club not found.</p>;
  if (!canManage) {
    return (
      <div className="card card-pad" style={{ maxWidth: 480 }}>
        <h2 className="display" style={{ fontSize: 22 }}>You don&rsquo;t manage this club</h2>
        <p style={{ color: 'var(--ink-soft)' }}>Only club managers or league admins can view a club&rsquo;s cart.</p>
      </div>
    );
  }

  const switchableClubs = (caps.isAdmin
    ? db.clubs
    : db.clubs.filter((c) => caps.managedClubIds.includes(c.id))
  ).slice().sort((a, b) => a.name.localeCompare(b.name));

  const cart = db.carts[club.id] ?? [];
  const displayName = club.shortName || club.name;

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title display" style={{ marginBottom: 0 }}>{displayName} Cart</h1>
        {switchableClubs.length > 1 && (
          <div style={{ minWidth: 240 }}>
            <Combo
              options={switchableClubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
              value={club.id}
              placeholder="Switch club…"
              onChange={(v) => { if (v && v !== club.id) navigate(`/club/${v}/cart`); }}
            />
          </div>
        )}
      </div>
      <p className="page-sub" style={{ marginTop: 2 }}>
        Memberships pushed to the club, event entries, and add-ons. Billed to {displayName}.{' '}
        <Link to={`/club/${club.id}/roster`}>Back to club page →</Link>
      </p>

      {removedNotices.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 14, maxWidth: 620 }}>
          <strong style={{ display: 'block', marginBottom: 6, color: 'var(--navy-800)', fontSize: 14 }}>
            Some cart lines were removed automatically
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: 'var(--navy-700)' }}>
            {removedNotices.map((msg, i) => <li key={i}>{msg}</li>)}
          </ul>
          <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setRemovedNotices([])}>Dismiss</button>
        </div>
      )}

      <CartScope
        cart={cart}
        ownerKey={club.id}
        isClub
        name={displayName}
        registrationsReturnTo={() => `/club/${club.id}/registrations`}
        otherReturnTo={`/club/${club.id}/registrations`}
        membershipsReturnTo={`/club/${club.id}/registrations`}
        onRemoved={(message, isError) => toast(message, isError ? { variant: 'error' } : undefined)}
        receiptsRef={receiptsRef}
      />

      <div ref={receiptsRef} style={{ marginTop: 32 }}>
        <ReceiptsSection clubId={club.id} forName={displayName} />
      </div>
    </div>
  );
}

export default ClubCartPage;
