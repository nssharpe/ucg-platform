# docs/reference/ — source materials from Julia (received 2026-07-06)

Raw inputs, kept verbatim. The structured digest + platform gap analysis lives in
[`../specs/2026-07-06-event-management-v2-requirements.md`](../specs/2026-07-06-event-management-v2-requirements.md)
— read that first; come back here only when you need Julia's exact wording or the
legacy tools' behavior.

| File | What it is |
|------|------------|
| `Reg & Scoring Platform Specification - Event Management.md` | **Julia's event-management requirements spec** (camps/clinics, competition registration setup, sanction management, refunds, nationals dashboards, finance dashboards, event communication/exports). Sections marked `[TBD]`/"skip for now": session/rotation/squad setup detail, scoring, results, exports for competitions. |
| `NationalsReg.js` / `NationalsReg.html` | The **current-year (2026) Nationals registration-summary tool**: a Google Apps Script JSON API over the "Registration Email Master" sheet + a WordPress-embedded frontend. Clubs (or independent athletes) pick their club/name, see their full registration summary (WAG/MAG/T&T athletes per apparatus, team summaries, decathlon/omnithon, coaches, add-ons with refund-adjusted quantities, session *requests*), submit a typed-name confirmation, and independents submit session-request surveys. |
| `NationalsCheckin.js` / `NationalsCheckin.html` | Same architecture for **check-in**: shows assigned sessions (vs. requested), check-in totals incl. athlete-gift counts, and a stronger "I have counted all items" confirmation. Per Julia: the reg page shows session *requests*, the check-in page shows *assigned* sessions + total-athlete/gift counts. |
| `Registration Email Master.xlsx` | Data backend for NationalsReg: sheets `Club Emails`, `Ind Emails`, `WAG/MAG/TnT Athlete Data`, `WAG/MAG Team Summary`, `Multiple Discipline Summary`, `Session Request Summary`, `Independent Session Request`, `Coach Summary`, `Add-On Summary`, `Add-On Ind`, `Registration Confirmations`, `REG FLAG`. |
| `Check-In Email Master.xlsx` | Data backend for NationalsCheckin: adds `Check-In Totals`, `Ind Check-In Totals`, `Session Assignment Summary`, `Ind Session Summary`, `Extra Late Reg`, `BAD REG`, `No Banquet`. |

Why the legacy tools matter: they are the concrete model for the platform's
**nationals registration-summary / check-in dashboards** (Julia's spec §"Nationals
Only Summary Dashboard") — the platform should replace the sheet+Apps-Script+
WordPress pipeline, including the refund-adjusted add-on quantities and the
club/independent confirmation ("typed name = signature") flow.
