// Browser-only: generate and directly download a PDF "proof of electronic
// signature" for a waiver signature — the legal artifact (signer, full timestamp
// with timezone, IP, document version + hash, consent) PLUS the full text of the
// waiver that was actually signed.
import { jsPDF } from 'jspdf';
import type { WaiverSignature } from './types';

/** Full local timestamp with timezone, plus the UTC instant for the record. */
export function formatSignedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const local = d.toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
  return `${local} (${d.toISOString().replace('T', ' ').slice(0, 19)} UTC)`;
}

/** Crude but dependency-free HTML → plain text: drop tags, turn block elements
 *  into line breaks, decode the common entities, collapse runs of whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div|\/tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&mdash;/gi, '—').replace(/&rarr;/gi, '→')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/** Generate and download a PDF proof of signature. `waiverBodyHtml` is the exact
 *  document text the signer agreed to (rendered into the PDF). */
export function downloadWaiverProof(
  sig: WaiverSignature, version: number, athleteName: string, waiverBodyHtml?: string,
): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 56;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;

  const ensure = (h: number) => { if (y + h > bottom) { doc.addPage(); y = margin; } };
  const para = (text: string, size = 10, gap = 4, color = 30) => {
    doc.setFontSize(size); doc.setTextColor(color);
    for (const line of doc.splitTextToSize(text, width)) {
      ensure(size + gap); doc.text(line, margin, y); y += size + gap;
    }
  };

  doc.setFont('helvetica', 'bold');
  para('United Club Gymnastics / NAIGC — Proof of Electronic Signature', 15, 6, 20);
  doc.setFont('helvetica', 'normal');
  para(`Generated ${formatSignedAt(new Date().toISOString())}`, 9, 8, 120);
  y += 6;

  const rows: [string, string][] = [
    ['Athlete / member', athleteName],
    ['Signed by', sig.signerRole === 'guardian'
      ? `${sig.signerName} — parent/guardian${sig.signerRelationship ? ` (${sig.signerRelationship})` : ''}`
      : sig.signerName],
    ['Signer email', sig.signerEmail ?? '—'],
    ['Waiver', `${sig.waiverType} — version ${version}`],
    ['Document hash (SHA-256)', sig.contentHash],
    ['Signed at', formatSignedAt(sig.signedAt)],
    ['IP address', sig.ip ?? 'unknown'],
    ['Consent given', sig.consent ? 'Yes' : 'No'],
    ['User agent', sig.userAgent ?? '—'],
  ];
  doc.setFont('helvetica', 'normal');
  for (const [k, v] of rows) {
    doc.setFontSize(9); doc.setTextColor(110);
    ensure(13); doc.text(k, margin, y);
    doc.setFontSize(10); doc.setTextColor(20);
    for (const line of doc.splitTextToSize(v, width - 150)) { doc.text(line, margin + 150, y); y += 13; }
  }
  y += 8;
  para('The signer named above electronically agreed to the waiver identified by the version and SHA-256 document hash. The timestamp, timezone, and originating IP address were recorded server-side at signing and have not been altered. The exact text agreed to follows.', 9, 4, 90);

  if (waiverBodyHtml) {
    y += 10; ensure(20);
    doc.setFont('helvetica', 'bold'); para('Waiver text as signed', 12, 6, 20);
    doc.setFont('helvetica', 'normal');
    para(htmlToText(waiverBodyHtml), 9.5, 3.5, 40);
  }

  const safe = athleteName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  doc.save(`waiver-proof-${safe}-${sig.waiverType.toLowerCase()}.pdf`);
}
