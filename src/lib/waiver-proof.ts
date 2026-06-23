// Browser-only: render a printable "proof of electronic signature" for a waiver
// signature and open the print dialog (Save as PDF). This is the downloadable
// legal proof (name, signature, full timestamp with timezone, IP, document
// version + hash). Server-generated, email-attachable PDFs are a later addition
// (Phase 5/6) once that path is verified; this gives a reliable download now.
import type { WaiverSignature } from './types';

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

/** Open a print-ready proof of signature in a new window and trigger print. */
export function downloadWaiverProof(
  sig: WaiverSignature, version: number, athleteName: string,
): void {
  const signer = sig.signerRole === 'guardian'
    ? `${esc(sig.signerName)} — parent/guardian of ${esc(athleteName)}${sig.signerRelationship ? ` (${esc(sig.signerRelationship)})` : ''}`
    : esc(sig.signerName);
  const rows: [string, string][] = [
    ['Athlete / member', esc(athleteName)],
    ['Signed by', signer],
    ['Signer email', esc(sig.signerEmail ?? '—')],
    ['Waiver', `${esc(sig.waiverType)} — version ${version}`],
    ['Document hash (SHA-256)', esc(sig.contentHash)],
    ['Signed at', esc(formatSignedAt(sig.signedAt))],
    ['IP address', esc(sig.ip ?? 'unknown')],
    ['Consent given', sig.consent ? 'Yes' : 'No'],
    ['User agent', esc(sig.userAgent ?? '—')],
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Waiver proof — ${esc(athleteName)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #14233a; max-width: 720px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 20px; border-bottom: 2px solid #14233a; padding-bottom: 8px; }
  .sub { color: #5a6b82; font-size: 13px; margin-top: -4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 13.5px; }
  td { padding: 8px 10px; border-bottom: 1px solid #d8e0ea; vertical-align: top; }
  td.k { color: #5a6b82; width: 200px; font-family: Arial, sans-serif; font-size: 12.5px; }
  td.v { word-break: break-word; }
  .stmt { margin-top: 22px; font-size: 13px; line-height: 1.6; }
  .foot { margin-top: 28px; font-size: 11px; color: #8a98ab; }
  @media print { body { margin: 0; } }
</style></head><body>
  <h1>NAIGC / United Club Gymnastics — Proof of Electronic Signature</h1>
  <div class="sub">Generated ${esc(formatSignedAt(new Date().toISOString()))}</div>
  <table><tbody>
    ${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join('')}
  </tbody></table>
  <p class="stmt">The signer named above electronically agreed to the waiver identified by the
  version and SHA-256 document hash above. The timestamp, timezone, and originating IP address
  were recorded server-side at the time of signing and have not been altered.</p>
  <p class="foot">This document was generated from the United Club Gymnastics signature record.
  Use your browser's “Save as PDF” to retain a copy.</p>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
