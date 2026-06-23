import { useMemo } from 'react';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge } from '../components/ui';
import { fmtMoney } from '../lib/scoring';
import { downloadReceipt, invoiceTotal } from '../lib/receipt';

/** Purchases History (MY UCG): every invoice tied to this account — memberships
 *  and meet entries — each with a downloadable receipt. */
export function PurchaseHistory() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to view your purchases</h2>
      </div>
    );
  }
  return <PurchaseHistoryInner personId={caps.person.id} name={`${caps.person.firstName} ${caps.person.lastName}`} />;
}

function PurchaseHistoryInner({ personId, name }: { personId: string; name: string }) {
  const db = useDB();

  // Invoices billed directly to this person, or any invoice containing a line
  // item processed on their behalf (e.g. a club-paid meet entry).
  const invoices = useMemo(() =>
    db.invoices
      .filter((inv) => inv.athleteId === personId || inv.items.some((i) => i.refUserId === personId))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.invoices, personId],
  );

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">Purchase History</h1>
      <p className="page-sub">Membership and meet-entry receipts processed on your account.</p>

      {invoices.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No purchases yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {invoices.map((inv) => {
            const date = inv.createdAt.slice(0, 10);
            // Only show line items relevant to this person when it's a shared (club) invoice.
            const mine = inv.athleteId === personId ? inv.items : inv.items.filter((i) => i.refUserId === personId);
            return (
              <div key={inv.id} className="card card-pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <strong>{inv.number}</strong>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{date}</span>
                  {inv.paidAt ? <Badge tone="ok">Paid</Badge> : <Badge tone="warn">Unpaid</Badge>}
                  <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
                  <button className="btn small ghost" onClick={() => downloadReceipt(inv, name)}>Download receipt</button>
                </div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13.5, color: 'var(--ink-soft)' }}>
                  {mine.map((i) => (
                    <li key={i.id}>{i.label} — {fmtMoney(i.refunded ? 0 : i.amount)}{i.refunded ? ' (refunded)' : ''}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PurchaseHistory;
