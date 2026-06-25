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

/** Collapse whitespace and decode the common HTML entities (matches the set the
 *  old plain-text path handled). DOMParser already decodes named/numeric entities
 *  in text nodes, but we keep this for any that slip through and to normalize runs
 *  of whitespace introduced by source-HTML indentation. */
function decodeText(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&mdash;/gi, '—').replace(/&rarr;/gi, '→')
    .replace(/[ \t\r\n]+/g, ' ');
}

/** Shared layout machinery handed to the HTML renderer so it draws into the same
 *  page/cursor state as the metadata section above it. */
interface RenderCtx {
  margin: number;
  width: number;
  bottom: number;
  ensure: (h: number) => void;
  getY: () => number;
  setY: (v: number) => void;
}

/** A run of text with a single weight/style, for inline bold/italic. */
type Run = { text: string; bold: boolean; italic: boolean };

/** Flatten an element's descendants into styled runs. `<strong>/<b>` set bold,
 *  `<em>/<i>` set italic; everything else just carries the inherited style.
 *  `<br>` injects a newline marker. We don't track nesting depth beyond on/off,
 *  which is sufficient for the waiver vocabulary. */
function collectRuns(node: Node, bold: boolean, italic: boolean, out: Run[]): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push({ text: child.textContent ?? '', bold, italic });
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') { out.push({ text: '\n', bold, italic }); return; }
    const b = bold || tag === 'strong' || tag === 'b';
    const i = italic || tag === 'em' || tag === 'i';
    collectRuns(el, b, i, out);
  });
}

const styleOf = (r: { bold: boolean; italic: boolean }): 'bold' | 'italic' | 'bolditalic' | 'normal' =>
  r.bold && r.italic ? 'bolditalic' : r.bold ? 'bold' : r.italic ? 'italic' : 'normal';

/** A layout token: a single word carrying its style, or a hard line break. */
type Tok = { word: string; bold: boolean; italic: boolean } | { brk: true };

/** Render a sequence of styled runs as wrapped lines with an optional hanging
 *  indent. Inline approximation: we tokenize into words (keeping each word's
 *  weight/style), then lay them out left-to-right, switching the font per word and
 *  advancing x via `getTextWidth` — so mixed bold/italic spans on one line render
 *  with their real weights, not a whole-block fallback. Wrapping is greedy on word
 *  boundaries; `<br>` forces a break. Page-breaks via ctx.ensure per line. */
function renderRuns(
  doc: jsPDF, ctx: RenderCtx, runs: Run[], size: number, gap: number, color: number, indent: number,
): void {
  const lineH = size + gap;
  const maxX = ctx.margin + ctx.width;
  const wrapX = ctx.margin + indent;
  doc.setFontSize(size); doc.setTextColor(color);

  // Build the token stream: split each run's text on whitespace; <br> -> {brk}.
  const toks: Tok[] = [];
  for (const run of runs) {
    const parts = decodeText(run.text).split('\n'); // decodeText already collapses spaces
    parts.forEach((seg, si) => {
      if (si > 0) toks.push({ brk: true });
      seg.split(' ').forEach((w) => {
        if (w !== '') toks.push({ word: w, bold: run.bold, italic: run.italic });
      });
    });
  }
  if (toks.length === 0) return;

  const spaceW = () => { doc.setFont('helvetica', 'normal'); return doc.getTextWidth(' '); };

  // First line starts at the indented x too (wrapX). For paragraphs/headings indent
  // is 0 so this is the margin; for list items it clears the bullet/counter marker.
  let x = wrapX;
  let lineStarted = false;
  ctx.ensure(lineH);

  const breakLine = () => { ctx.setY(ctx.getY() + lineH); x = wrapX; lineStarted = false; ctx.ensure(lineH); };

  for (const tok of toks) {
    if ('brk' in tok) { breakLine(); continue; }
    doc.setFont('helvetica', styleOf(tok));
    const wordW = doc.getTextWidth(tok.word);
    const gapW = lineStarted ? spaceW() : 0;
    if (lineStarted && x + gapW + wordW > maxX) breakLine();
    if (lineStarted) x += spaceW();
    doc.setFont('helvetica', styleOf(tok));
    doc.text(tok.word, x, ctx.getY());
    x += wordW;
    lineStarted = true;
  }
  ctx.setY(ctx.getY() + lineH); // close the final line
}

/** Token-based HTML → jsPDF renderer. Walks the sanitized waiver HTML body and
 *  emits styled vector text: headings (bold, larger), paragraphs, and ul/ol lists
 *  with bullets/counters and a hanging indent. Page-breaks safely via ctx.ensure.
 *  Inline <strong>/<b> and <em>/<i> render with their real weights (see renderRuns);
 *  links render as plain text (their URL is not emitted — the on-screen waiver shows
 *  it, and adding link annotations is out of scope). */
function renderWaiverHtml(doc: jsPDF, html: string, ctx: RenderCtx): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const body = parsed.body;

  const heading = (el: Element, size: number) => {
    ctx.setY(ctx.getY() + 6); // extra top gap before a heading
    const runs: Run[] = [];
    collectRuns(el, true, false, runs); // headings are bold regardless of inner markup
    renderRuns(doc, ctx, runs, size, 5, 20, 0);
    ctx.setY(ctx.getY() + 3);
  };

  const paragraph = (el: Element) => {
    const runs: Run[] = [];
    collectRuns(el, false, false, runs);
    if (runs.every((r) => decodeText(r.text).trim() === '')) return; // skip empty <p>
    renderRuns(doc, ctx, runs, 9.5, 3.5, 40, 0);
    ctx.setY(ctx.getY() + 5); // blank-line gap after a paragraph
  };

  const list = (el: Element, ordered: boolean) => {
    const indent = 16;
    let n = 0;
    el.childNodes.forEach((li) => {
      if (li.nodeType !== Node.ELEMENT_NODE) return;
      if ((li as Element).tagName.toLowerCase() !== 'li') return;
      n += 1;
      const marker = ordered ? `${n}. ` : '• ';
      // Draw the marker at the left margin, then the item text hanging-indented.
      ctx.ensure(9.5 + 3.5);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40);
      doc.text(marker, ctx.margin, ctx.getY());
      const runs: Run[] = [];
      collectRuns(li as Element, false, false, runs);
      renderRuns(doc, ctx, runs, 9.5, 3.5, 40, indent);
      ctx.setY(ctx.getY() + 2);
    });
    ctx.setY(ctx.getY() + 4);
  };

  body.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = decodeText(node.textContent ?? '').trim();
      if (t) renderRuns(doc, ctx, [{ text: t, bold: false, italic: false }], 9.5, 3.5, 40, 0);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    switch (el.tagName.toLowerCase()) {
      case 'h1': heading(el, 13); break;
      case 'h2': heading(el, 12); break;
      case 'h3': heading(el, 11); break;
      case 'ul': list(el, false); break;
      case 'ol': list(el, true); break;
      case 'p': case 'div': paragraph(el); break;
      default: paragraph(el); break; // unknown block: render as a paragraph
    }
  });
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
    renderWaiverHtml(doc, waiverBodyHtml, { margin, width, bottom, ensure, getY: () => y, setY: (v) => { y = v; } });
  }

  const safe = athleteName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  doc.save(`waiver-proof-${safe}-${sig.waiverType.toLowerCase()}.pdf`);
}
