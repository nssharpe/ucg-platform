# ScoreFlippers import report

- Clubs: **222**
- People: **2615** (athletes)
- Duplicate AthleteIDs skipped: 2 ['363564', '485428']
- People with ClubID not in club list (main_club_id set NULL): 35 across 1 ids {'': 35}
- Missing email people: 3
- Missing grad year: 359

## Unmapped CompLevel codes (resolved 2026-06-13)
- `NC` (7 athletes) -> renamed to **Advanced**, mapped to MAG / mag-adv. Applied
  live via `fixups.sql` (ids 298238, 298219, 298220, 528699, 528708, 528732, 538743).
- `L7` (1 athlete) -> renamed to **Developmental**, mapped to MAG / mag-dev. Applied
  live via `fixups.sql` (id 398531).

## CompLevel -> level mapping used
- `XS` -> WAG / wag-silver
- `XP` -> WAG / wag-plat
- `XD` -> WAG / wag-diamond
- `L9` -> WAG / wag-l9
- `Open` -> WAG / wag-open
- `Dev` -> MAG / mag-dev
- `Int` -> MAG / mag-int
- `Adv` -> MAG / mag-adv
- `NC` -> MAG / mag-adv (renamed "Advanced", see above)
- `L7` -> MAG / mag-dev (renamed "Developmental", see above)
- `MSTR` -> MAG / mag-masters (see "WAG Masters" note below — 53 of the 69 MSTR
  athletes are Female/Other and may belong on `wag-masters` instead; not yet split)
- `NF` -> TNT / tnt-new
- `IF` -> TNT / tnt-int
- `HF` -> TNT / tnt-high

## WAG Masters gap (found + partially fixed 2026-06-13)
The NAIGC Masters rule set applies to both MAG and WAG, but the platform had only
ever been wired up for MAG:
- `src/scoring/masters.ts` already had full WAG data (EG labels, vault tables, age
  bonuses) but `init()` hardcoded `discipline = 'MAG'` regardless of level.
- `src/lib/calculators.ts` `calcForLevel()` had no case for a `wag-masters` level.
- `src/lib/seed.ts` had no `wag-masters` entry in the `levels` list.

**Fixed**: added `wag-masters` (WAG, "Masters", order 6) to `seed.ts` and the live
`levels` table; added a `wag-masters` case to `calcForLevel()` (reuses the same
`masters.html` calculator); `masters.ts` `init()` now derives `discipline` from
`_levelId` (`wag-masters` -> WAG, else MAG).

**Still open**: all 69 `MSTR`-CompLevel athletes were imported with
`levels = {"MAG":"mag-masters"}`. Of these, 50 are Female and 3 are Other (53
total) — these likely belong on `wag-masters` instead, but the split was not
applied live pending confirmation from Nate (re-assigning 69 athletes' levels by
gender is a judgment call, not something to infer silently). Once confirmed, run:
```sql
update people set levels = '{"WAG":"wag-masters"}'::jsonb
where gender != 'Male' and levels->>'MAG' = 'mag-masters';
```

## Club region normalizations / fallbacks
- GymACT: SF region 'NAIGC', state 'ZZ' -> 'Other'
- Independent Community Athlete: SF region 'NAIGC', state 'ZZ' -> 'Other'
- Independent Student Athlete: SF region 'NAIGC', state 'ZZ' -> 'Other'
- MASTERS - Individual: SF region 'NAIGC', state 'ZZ' -> 'Other'
- NAIGC - Main: SF region 'NAIGC' -> derived 'Northeast' from New York
- NAIGC Alumni: SF region 'NAIGC' -> derived 'Mid-Atlantic' from Virginia
- NAIGC Test: SF region 'NAIGC' -> derived 'Northeast' from New York
- NAIGC Volunteers: SF region 'NAIGC' -> derived 'Northeast' from New York
- Southern Methodist University: SF region 'Unassigned' -> derived 'South Central' from Texas
- Team Germany: SF region 'NAIGC', state 'GE' -> 'Other'
- Team Great Britain: SF region 'NAIGC', state 'OX' -> 'Other'
- Team Ireland: SF region 'NAIGC', state 'BS' -> 'Other'
- Team Japan: SF region 'NAIGC', state 'TO' -> 'Other'
- Team USA: SF region 'NAIGC' -> derived 'Northeast' from Massachusetts
- Tulane University Club Gymnastics: SF region 'NAIGC' -> derived 'Southeast' from Louisiana
- Universite Catholique de Louvain: SF region 'NAIGC', state 'ZZ' -> 'Other'