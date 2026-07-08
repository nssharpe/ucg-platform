import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { NationalsConfigEditor } from '../components/NationalsConfigEditor';
import { exportAwardsDeck } from '../lib/awards-deck';
import {
  computeNationals,
  computeArtisticDiscipline,
  computeNationalsValidation,
  type ArtisticDisciplineResult,
} from '../lib/nationals-adapter';
import { fmtScore } from '../lib/scoring';
import type { Event, NationalsConfig, PlacementCategory } from '../lib/types';
import type { AwardTable } from '../nationals';

const TABS = ['Config', 'Qualification', 'Awards', 'Validation'] as const;
type Tab = (typeof TABS)[number];

const levelName = (db: ReturnType<typeof useDB>, id: string) => db.levels.find((l) => l.id === id)?.name ?? id;

export function Nationals() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const event = db.events.find((m) => m.slug === slug);
  const [tab, setTab] = useState<Tab>('Config');

  const bundle = useMemo(() => (event ? computeNationals(db, event) : null), [db, event]);
  const validation = useMemo(() => (event ? computeNationalsValidation(db, event) : []), [db, event]);

  if (!event) return <div className="page"><p>Event not found.</p></div>;
  if (event.kind !== 'nationals') return <div className="page"><p>This isn’t a Nationals event.</p></div>;
  if (!caps.isEventHost(event.id)) return <div className="page"><p>You don’t have access to manage this event.</p></div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title display">{event.name} — Nationals</h1>
        <Link className="btn ghost small" to={`/events/${event.slug}`}>← Event page</Link>
      </div>
      <p className="page-sub">Finals qualification &amp; awards, computed on-platform.</p>

      <div style={{ display: 'flex', gap: 6, margin: '12px 0 18px', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t} className={`btn small ${t === tab ? 'primary' : 'ghost'}`} onClick={() => setTab(t)}>
            {t}{t === 'Validation' && validation.length ? ` (${validation.length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'Config' && <NationalsConfigEditor event={event} />}
      {tab === 'Qualification' && bundle && <QualificationView event={event} db={db} />}
      {tab === 'Awards' && bundle && <AwardsView event={event} db={db} bundle={bundle} />}
      {tab === 'Validation' && <ValidationView issues={validation} />}
    </div>
  );
}

function QualificationView({ event, db }: { event: Event; db: ReturnType<typeof useDB> }) {
  const disciplines = (['WAG', 'MAG'] as const).filter((d) => event.disciplines.includes(d));
  const cfg = event.nationalsConfig!;
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0 }}>
        Finals roster per finals level. <span style={{ background: 'var(--coral-100, #fde4dd)', padding: '0 4px', borderRadius: 3 }}>Highlighted</span> rows
        were pulled in by the 50% cross-club rule (placed below the cutoff).
      </p>
      {disciplines.map((d) => {
        const res = computeArtisticDiscipline(db, event, d);
        return <DisciplineRoster key={d} discipline={d} res={res} cfg={cfg} db={db} />;
      })}
      {disciplines.length === 0 && <p>No WAG/MAG disciplines in this event.</p>}
    </div>
  );
}

function DisciplineRoster({ discipline, res, cfg, db }: { discipline: string; res: ArtisticDisciplineResult; cfg: NationalsConfig; db: ReturnType<typeof useDB> }) {
  const finalsLevels = cfg.finalsLevelIds.filter((id) => db.levels.find((l) => l.id === id)?.discipline === discipline);
  if (finalsLevels.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 className="card-title">{discipline === 'TNT' ? 'T&T' : discipline} finals</h3>
      {finalsLevels.map((levelId) => {
        const rows = res.prelims.results
          .filter((r) => r.level === levelId && (r.aa?.qual === 'Y' || Object.values(r.apparatus).some((e) => e.qual === 'Y') || r.teamQual === 'Y'))
          .sort((a, b) => (a.aa?.place ?? 999) - (b.aa?.place ?? 999));
        if (!rows.length) return <p key={levelId} style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{levelName(db, levelId)}: no qualifiers yet.</p>;
        return (
          <div key={levelId} style={{ marginBottom: 14, overflowX: 'auto' }}>
            <h4 style={{ fontSize: 14, margin: '8px 0 4px' }}>{levelName(db, levelId)}</h4>
            <table className="res-tbl" style={{ fontSize: 13 }}>
              <thead><tr><th style={{ textAlign: 'left' }}>AA place</th><th style={{ textAlign: 'left' }}>Athlete</th><th style={{ textAlign: 'left' }}>Club</th><th style={{ textAlign: 'left' }}>Category</th><th>AA</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const aaCut = cfg.cutoffs.aa[r.category as PlacementCategory]?.[levelId] ?? 0;
                  const pullIn = r.aa?.qual === 'Y' && (r.aa?.place ?? 0) > aaCut;
                  return (
                    <tr key={r.entry.id} style={pullIn ? { background: 'var(--coral-100, #fde4dd)' } : undefined}>
                      <td style={{ textAlign: 'left' }}>{r.aa?.place ?? '—'}</td>
                      <td style={{ textAlign: 'left' }}>{r.entry.first} {r.entry.last}</td>
                      <td style={{ textAlign: 'left' }}>{r.entry.club}</td>
                      <td style={{ textAlign: 'left' }}>{r.category}</td>
                      <td style={{ textAlign: 'center' }}>{fmtScore(r.aa?.score)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function AwardsView({ event, db, bundle }: { event: Event; db: ReturnType<typeof useDB>; bundle: ReturnType<typeof computeNationals> }) {
  const sections: { title: string; tables: AwardTable[] }[] = [];
  if (bundle.wag) sections.push({ title: 'WAG', tables: bundle.wag.awards });
  if (bundle.mag) sections.push({ title: 'MAG', tables: bundle.mag.awards });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button className="btn primary small" onClick={() => exportAwardsDeck(db, event, bundle)}>Download awards deck (.pptx)</button>
      </div>
      {sections.map((s) => (
        <div key={s.title} style={{ marginBottom: 18 }}>
          <h3 className="card-title">{s.title} awards</h3>
          {s.tables.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>No awards yet — enter scores and set cutoffs.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {s.tables.map((t, i) => (
              <div key={i} className="card card-pad">
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-soft)', marginBottom: 6 }}>
                  {levelName(db, t.level)} · {t.scope === 'AA' ? 'All-Around' : t.scope === 'Team' ? 'Team' : t.scope} · {t.category}
                  {t.fromFinals && <span style={{ color: 'var(--coral-600)' }}> · finals</span>}
                </div>
                <table className="res-tbl" style={{ fontSize: 13 }}>
                  <tbody>
                    {t.entries.map((e) => (
                      <tr key={`${e.place}-${e.name}`}>
                        <td style={{ width: 28 }}>{e.place}</td>
                        <td style={{ textAlign: 'left' }}>{e.name}</td>
                        <td style={{ textAlign: 'left', color: 'var(--ink-soft)' }}>{t.scope === 'Team' ? '' : e.club}</td>
                        <td style={{ textAlign: 'right' }}>{fmtScore(e.score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      ))}
      {bundle.decathlon.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <h3 className="card-title">Decathlon (2×WAG AA + MAG AA)</h3>
          <table className="res-tbl" style={{ fontSize: 13, maxWidth: 520 }}>
            <thead><tr><th>Place</th><th style={{ textAlign: 'left' }}>Athlete</th><th style={{ textAlign: 'left' }}>Club</th><th style={{ textAlign: 'left' }}>Levels</th><th>Score</th></tr></thead>
            <tbody>
              {bundle.decathlon.filter((r) => r.qual === 'Y').map((r) => (
                <tr key={`${r.first}-${r.last}-${r.level}`}><td>{r.place}</td><td style={{ textAlign: 'left' }}>{r.first} {r.last}</td><td style={{ textAlign: 'left' }}>{r.club}</td><td style={{ textAlign: 'left' }}>{r.level}</td><td style={{ textAlign: 'center' }}>{fmtScore(r.overall)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {bundle.omnithon.filter((r) => r.qual === 'Y').length > 0 && (
        <div>
          <h3 className="card-title">Omnithon (competed all of WAG + MAG + T&amp;T)</h3>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 6px' }}>Reference tool has no composite Omnithon score — this lists athletes who competed everything.</p>
          <ul style={{ fontSize: 13, margin: 0 }}>
            {bundle.omnithon.filter((r) => r.qual === 'Y').map((r) => <li key={`${r.first}-${r.last}`}>{r.first} {r.last} — {r.club}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function ValidationView({ issues }: { issues: { discipline: string; group: string; detail: string }[] }) {
  if (!issues.length) return <p style={{ color: 'var(--green-700, #2e7d32)', fontWeight: 600 }}>No data issues found. ✓</p>;
  const byGroup = new Map<string, typeof issues>();
  for (const i of issues) {
    const k = `${i.discipline} · ${i.group}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(i);
  }
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0 }}>Resolve these before finalizing awards.</p>
      {[...byGroup.entries()].map(([group, items]) => (
        <div key={group} style={{ marginBottom: 14 }}>
          <h4 style={{ fontSize: 14, margin: '0 0 4px' }}>{group}</h4>
          <ul style={{ fontSize: 13, margin: 0 }}>
            {items.map((i, n) => <li key={n}>{i.detail}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}
