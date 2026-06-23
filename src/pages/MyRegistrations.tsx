import { useMemo, useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Tabs } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { pushRegistration } from '../lib/supabase';
import type { Registration } from '../lib/types';

const today = () => new Date().toISOString().slice(0, 10);

/** "My Registrations" (MY UCG): all events this athlete is/was registered for,
 *  split into Upcoming / Past, searchable, expandable, with an option to change
 *  which affiliated club they're registered with for an upcoming competition. */
export function MyRegistrations() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to view your registrations</h2>
      </div>
    );
  }
  return <MyRegistrationsInner personId={caps.person.id} />;
}

function MyRegistrationsInner({ personId }: { personId: string }) {
  const db = useDB();
  const toast = useToast();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';
  const nameOf = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // Group this athlete's (non-refunded) registrations by meet.
  const byMeet = useMemo(() => {
    const mine = db.registrations.filter((r) => r.athleteId === personId && !r.refunded);
    const groups = new Map<string, Registration[]>();
    for (const r of mine) {
      const arr = groups.get(r.meetId) ?? [];
      arr.push(r);
      groups.set(r.meetId, arr);
    }
    return [...groups.entries()]
      .map(([meetId, regs]) => ({ meet: db.meets.find((m) => m.id === meetId), regs }))
      .filter((g): g is { meet: NonNullable<typeof g.meet>; regs: Registration[] } => !!g.meet)
      .sort((a, b) => b.meet.startDate.localeCompare(a.meet.startDate));
  }, [db.registrations, db.meets, personId]);

  const t = today();
  const lq = q.trim().toLowerCase();
  const filtered = byMeet
    .filter((g) => (tab === 'upcoming' ? g.meet.endDate >= t : g.meet.endDate < t))
    .filter((g) => !lq || g.meet.name.toLowerCase().includes(lq) || g.meet.city.toLowerCase().includes(lq));

  // Clubs this athlete is affiliated with (main + alt) — for the club switch.
  const me = db.people.find((p) => p.id === personId);
  const affiliatedClubIds = me ? [me.mainClubId, ...(me.altClubIds ?? [])].filter((x): x is string => !!x) : [];
  const affiliatedClubs = db.clubs.filter((c) => affiliatedClubIds.includes(c.id));

  const changeClub = (meetId: string, newClubId: string) => {
    mutate((d) => {
      for (const r of d.registrations) {
        if (r.meetId === meetId && r.athleteId === personId && !r.refunded) {
          r.clubId = newClubId;
          pushRegistration(r);
        }
      }
    });
    toast('Updated the club for this competition.');
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">My Registrations</h1>
      <p className="page-sub">Every event you’re registered for. Change which club you compete for on upcoming meets.</p>

      <Tabs
        tabs={[{ id: 'upcoming' as const, label: 'Upcoming' }, { id: 'past' as const, label: 'Past' }]}
        active={tab}
        onChange={(id) => { setTab(id); setExpanded(null); }}
      />

      <input
        type="search" className="input" placeholder="Search by meet or city…"
        value={q} onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 300, margin: '12px 0' }}
      />

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No {tab} registrations.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(({ meet, regs }) => {
            const isOpen = expanded === meet.id;
            const club = db.clubs.find((c) => c.id === regs[0]?.clubId);
            const regClosed = meet.regCloses < t;
            return (
              <div key={meet.id} className="card card-pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpanded(isOpen ? null : meet.id)}>
                  <strong style={{ fontSize: 15 }}>{meet.name}</strong>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {meet.startDate}{meet.endDate !== meet.startDate ? `–${meet.endDate}` : ''} · {meet.city}, {meet.state}
                  </span>
                  {club && <Badge tone="navy">{club.shortName || club.name}</Badge>}
                  <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 13 }}>{isOpen ? 'Hide' : 'Details'}</span>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                    <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 8 }}>
                      Status: {meet.status} · Registration closes {meet.regCloses}
                    </div>
                    <table className="tbl" style={{ marginBottom: 12 }}>
                      <tbody>
                        {regs.map((r) => {
                          const base = r.events.join(', ');
                          const evts = r.events.includes('SY') && r.partnerAthleteId
                            ? `${base} (synchro w/ ${nameOf(r.partnerAthleteId)})` : base;
                          return (
                            <tr key={r.id}>
                              <td>{r.discipline === 'TNT' ? 'T&T' : r.discipline}</td>
                              <td>{lvlName(r.levelId)}</td>
                              <td>{evts}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {tab === 'upcoming' ? (
                      affiliatedClubs.length > 1 ? (
                        <Field label="Club I’m competing for" hint={regClosed ? 'Registration is closed — changes may be limited.' : undefined}>
                          <Combo
                            options={affiliatedClubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
                            value={regs[0]?.clubId ?? null}
                            onChange={(v) => { if (v && v !== regs[0]?.clubId) changeClub(meet.id, v); }}
                          />
                        </Field>
                      ) : (
                        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: 0 }}>
                          To compete for a different club, add it as an affiliated club on your profile first.
                        </p>
                      )
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default MyRegistrations;
