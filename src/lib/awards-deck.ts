/**
 * Awards deck export. Builds a self-contained, print-ready HTML document (one
 * landscape "slide" per event/level/category award set, page-broken) and opens it
 * for the user to print or save as PDF — the on-platform replacement for the
 * reference tool's PowerPoint banquet deck.
 *
 * Dependency-free by design (the project path is build-fragile and a heavyweight
 * pptx lib isn't worth the risk yet). A future upgrade could emit a true .pptx via
 * pptxgenjs while keeping this structure.
 */
import type { DB, Meet } from './types';
import type { NationalsBundle } from './nationals-adapter';
import type { AwardTable } from '../nationals';
import { fmtScore } from './scoring';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function awardSlide(title: string, subtitle: string, rows: { place: number; name: string; club: string; score: number }[]): string {
  const body = rows
    .map((r) => `<tr><td class="pl">${r.place}</td><td>${esc(r.name)}</td><td class="club">${esc(r.club)}</td><td class="sc">${fmtScore(r.score)}</td></tr>`)
    .join('');
  return `<section class="slide">
    <h1>${esc(title)}</h1>
    <h2>${esc(subtitle)}</h2>
    <table><tbody>${body}</tbody></table>
  </section>`;
}

function disciplineSlides(label: string, tables: AwardTable[], levelName: (id: string) => string): string {
  return tables
    .map((t) => {
      const scope = t.scope === 'AA' ? 'All-Around' : t.scope === 'Team' ? 'Team' : t.scope;
      const title = `${label} ${levelName(t.level)} — ${scope}`;
      const subtitle = `${t.category}${t.fromFinals ? ' · Finals' : ''}`;
      return awardSlide(title, subtitle, t.entries.map((e) => ({ place: e.place, name: t.scope === 'Team' ? e.club : e.name, club: t.scope === 'Team' ? '' : e.club, score: e.score })));
    })
    .join('');
}

export function buildAwardsDeckHtml(db: DB, meet: Meet, bundle: NationalsBundle): string {
  const levelName = (id: string) => db.levels.find((l) => l.id === id)?.name ?? id;
  const slides: string[] = [
    `<section class="slide title"><h1>${esc(meet.name)}</h1><h2>Awards</h2></section>`,
  ];
  if (bundle.wag) slides.push(disciplineSlides('WAG', bundle.wag.awards, levelName));
  if (bundle.mag) slides.push(disciplineSlides('MAG', bundle.mag.awards, levelName));
  const dec = bundle.decathlon.filter((r) => r.qual === 'Y');
  if (dec.length) slides.push(awardSlide('Decathlon', '2×WAG AA + MAG AA', dec.map((r) => ({ place: r.place ?? 0, name: `${r.first} ${r.last}`, club: r.club, score: r.overall }))));

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meet.name)} — Awards</title>
  <style>
    @page { size: landscape; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Instrument Sans', system-ui, sans-serif; color: #1d2a38; }
    .slide { width: 100vw; height: 100vh; padding: 6vh 8vw; page-break-after: always; display: flex; flex-direction: column; }
    .slide.title { justify-content: center; align-items: center; text-align: center; background: #1d2a38; color: #dbebed; }
    .slide.title h1 { font-size: 48px; margin: 0; }
    .slide.title h2 { font-size: 28px; font-weight: 400; color: #f46949; margin: 8px 0 0; }
    h1 { font-size: 30px; margin: 0 0 2px; }
    h2 { font-size: 18px; font-weight: 600; color: #f46949; margin: 0 0 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 18px; }
    td { padding: 5px 10px; border-bottom: 1px solid #dbebed; }
    td.pl { width: 48px; font-weight: 700; }
    td.club { color: #5b6b7a; }
    td.sc { text-align: right; font-variant-numeric: tabular-nums; width: 90px; }
    @media screen { body { background: #e9eef1; } .slide { margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.15); width: 960px; height: 540px; } .print-bar { position: sticky; top: 0; padding: 10px; background: #1d2a38; text-align: center; } .print-bar button { font-size: 15px; padding: 8px 18px; cursor: pointer; } }
    @media print { .print-bar { display: none; } }
  </style></head>
  <body>
    <div class="print-bar"><button onclick="window.print()">Print / Save as PDF</button></div>
    ${slides.join('\n')}
  </body></html>`;
}

export function exportAwardsDeck(db: DB, meet: Meet, bundle: NationalsBundle): void {
  // Blob URL (not document.write): the browser parses our own escaped HTML in a
  // fresh tab where the user can print/save as PDF.
  const html = buildAwardsDeckHtml(db, meet, bundle);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
