// Browser-only: turn a `PersonDataExport` (src/lib/person-data.ts) into a
// downloadable JSON file (exact collected rows) and a human-readable PDF
// (jsPDF, matching the receipt/waiver-proof download patterns in
// receipt.ts / waiver-proof.ts) — the admin "Export data" action (F5).
import { jsPDF } from 'jspdf';
import type { PersonDataExport } from './person-data';

function filenameSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'person';
}

/** Download the exact collected rows as a JSON file — the "raw" export. */
export function downloadPersonDataJson(data: PersonDataExport): void {
  const name = data.person ? `${data.person.firstName} ${data.person.lastName}` : data.personId;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `person-data-${filenameSafe(name)}-${data.personId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Download a human-readable PDF summary of the same data (counts + key
 *  fields per section — not a full data dump, which the JSON already is). */
export function downloadPersonDataPdf(data: PersonDataExport): void {
  const name = data.person ? `${data.person.firstName} ${data.person.lastName}` : `Person ${data.personId}`;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 56;
  const pageW = doc.internal.pageSize.getWidth();
  const width = pageW - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;
  const ensure = (h: number) => { if (y + h > bottom) { doc.addPage(); y = margin; } };
  const heading = (text: string) => {
    ensure(24); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30, 43, 56);
    doc.text(text, margin, y); y += 16;
  };
  const line = (text: string) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60);
    const wrapped = doc.splitTextToSize(text, width);
    ensure(wrapped.length * 13);
    doc.text(wrapped, margin, y); y += wrapped.length * 13;
  };

  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(30, 43, 56);
  doc.text('United Club Gymnastics', margin, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(120);
  doc.text('Personal data export', margin, y + 16);
  const generated = new Date(data.generatedAt);
  const genStr = Number.isNaN(generated.getTime()) ? data.generatedAt
    : generated.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  doc.text(genStr, pageW - margin, y, { align: 'right' });
  y += 44;
  doc.setDrawColor(30, 43, 56); doc.line(margin, y, pageW - margin, y); y += 18;

  doc.setTextColor(30, 43, 56); doc.setFontSize(11);
  doc.text(`Subject: ${name} (person id ${data.personId})`, margin, y); y += 20;

  heading('Profile');
  if (data.person) {
    const p = data.person;
    line(`Name: ${p.firstName} ${p.lastName}`);
    line(`Email: ${p.email || '(none)'}`);
    line(`Phone: ${p.phone || '(none)'}`);
    line(`DOB: ${p.dob || '(none)'}`);
    line(`Address/state: ${p.state || '(none)'}, ${p.country || '(none)'}`);
    line(`SMS consent: ${p.smsConsent ? 'yes' : 'no'}`);
    line(`Emergency contact: ${p.emergency?.contact || '(none)'} (${p.emergency?.relation || ''}) ${p.emergency?.phone || ''}`);
    line(`Dietary: ${(p.dietary ?? []).join(', ') || '(none)'}${p.dietaryNotes ? ` — ${p.dietaryNotes}` : ''}`);
    line(`Main club: ${p.mainClubId ?? '(independent)'}; alt clubs: ${(p.altClubIds ?? []).join(', ') || '(none)'}`);
    line(`Memberships: ${p.memberships.map((m) => `${m.seasonId} (${m.type}, ${m.status})`).join('; ') || '(none)'}`);
  } else {
    line('No people row found for this id (already deleted/tombstoned).');
  }

  heading('Clubs managed');
  line(data.managedClubs.length ? data.managedClubs.map((c) => c.name).join(', ') : '(none)');

  heading(`Registrations (${data.registrations.length})`);
  if (data.registrations.length === 0) line('(none)');
  for (const r of data.registrations) {
    line(`${r.eventId} — ${r.discipline} — level ${r.levelId} — ${r.paid ? 'paid' : 'pending'}${r.refunded ? ' (refunded)' : ''}`);
  }

  heading(`Scores (${data.scores.length})`);
  line(data.scores.length ? `${data.scores.length} score row(s) — see JSON export for full detail.` : '(none)');

  heading(`Invoices billed to this person (${data.invoicesBilled.length})`);
  for (const inv of data.invoicesBilled) {
    line(`${inv.number} — created ${inv.createdAt}${inv.paidAt ? `, paid ${inv.paidAt}` : ', unpaid'}`);
  }
  if (data.invoicesBilled.length === 0) line('(none)');

  heading(`Payments (${data.payments.length})`);
  for (const pm of data.payments) {
    line(`${pm.id} — ${pm.status} — subtotal ${pm.amountSubtotal != null ? `$${(pm.amountSubtotal / 100).toFixed(2)}` : 'n/a'}`);
  }
  if (data.payments.length === 0) line('(none)');

  heading(`Cart items currently pending (${data.cartItems.length})`);
  for (const ci of data.cartItems) line(`${ci.label} — $${ci.amount.toFixed(2)}`);
  if (data.cartItems.length === 0) line('(none)');

  heading(`Refund requests (${data.refundRequests.length})`);
  for (const rr of data.refundRequests) line(`${rr.eventId} — ${rr.status} — reason: ${rr.reason}`);
  if (data.refundRequests.length === 0) line('(none)');

  heading(`Waiver signatures (${data.waiverSignatures.length})`);
  for (const w of data.waiverSignatures) line(`${w.seasonId} — signed ${w.signedAt} by ${w.signerName} (${w.signerRole})`);
  if (data.waiverSignatures.length === 0) line('(none)');

  heading('Other records');
  line(`Club requests: ${data.clubRequests.length}`);
  line(`Account invites: ${data.accountInvites.length}`);
  line(`Sanction requests filed: ${data.sanctionRequests.length}`);
  line(`Sanction votes cast: ${data.sanctionVotes.length}`);
  line(`Event-admin grants: ${data.eventAdmins.length}`);
  line(`Waitlist entries: ${data.waitlistGroups.length}`);
  line(`Session-request surveys: ${data.sessionRequests.length}`);
  line(`Event check-ins: ${data.eventCheckins.length}`);
  line(`Personally-restricted coupons: ${data.restrictedCoupons.length}`);

  y += 10; ensure(28);
  doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(140);
  const disclaimer = doc.splitTextToSize(
    'This is a human-readable summary. The accompanying JSON download contains the exact rows collected for this export.',
    width,
  );
  doc.text(disclaimer, margin, y);

  doc.save(`person-data-${filenameSafe(name)}-${data.personId}.pdf`);
}
