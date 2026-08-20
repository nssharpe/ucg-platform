"""Generate the UCG Preflight artifact page from the markdown test plan.

The 240 steps are PARSED from docs/plans/2026-08-19-uat-stress-test-plan.md so the
published page and the durable doc cannot drift apart. Prose sections are authored
here because they need bespoke layout.
"""
import html
import re
import sys

SRC = sys.argv[1]
OUT = sys.argv[2]

md = open(SRC, encoding="utf-8").read()

# --------------------------------------------------------------- inline markdown
def inline(s):
    s = html.escape(s.strip())
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    s = re.sub(r"\*(.+?)\*", r"<em>\1</em>", s)
    return s


# ------------------------------------------------------------------ lane parsing
LANE_RE = re.compile(r"^## Lane ([A-Z]) — (.+?)$", re.M)
lanes = []
matches = list(LANE_RE.finditer(md))
for i, m in enumerate(matches):
    letter, name = m.group(1), m.group(2)
    star = "⭐" in name
    name = name.replace("⭐", "").strip()
    end = matches[i + 1].start() if i + 1 < len(matches) else md.find("\n# Appendix A")
    body = md[m.end():end]

    note = ""
    nm = re.search(r"^\*(.+?)\*$", body, re.M)
    if nm:
        note = inline(nm.group(1))

    steps = []
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split(" | ")]
        if len(cells) != 3:
            cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) != 3:
            continue
        sid = cells[0].strip()
        if not re.fullmatch(r"[A-Z]-\d{2}", sid):
            continue
        steps.append((sid, inline(cells[1]), inline(cells[2])))
    lanes.append({"letter": letter, "name": name, "star": star, "note": note, "steps": steps})

total_steps = sum(len(l["steps"]) for l in lanes)
print("parsed lanes:", len(lanes), "steps:", total_steps)
assert total_steps == 240, f"expected 240 steps, parsed {total_steps}"

# ------------------------------------------------------------------- page pieces
def lane_html(l):
    star = '<span class="star" title="Priority lane">★</span>' if l["star"] else ""
    note = f'<p class="lane-note">{l["note"]}</p>' if l["note"] else ""
    rows = []
    for sid, do, exp in l["steps"]:
        flag = ""
        if "⚠️" in exp or "⚠️" in do:
            flag = " flagged"
        rows.append(
            f'<li class="step{flag}" data-id="{sid}">'
            f'<button class="mark" type="button" aria-pressed="false" '
            f'aria-label="Mark {sid} as reached"><span class="mark-box"></span>'
            f'<span class="sid">{sid}</span></button>'
            f'<div class="step-body">'
            f'<p class="do">{do}</p>'
            f'<p class="exp"><span class="exp-label">Expected</span>{exp}</p>'
            f'</div></li>'
        )
    return (
        f'<section class="lane" id="lane-{l["letter"]}" data-lane="{l["letter"]}">'
        f'<header class="lane-head">'
        f'<span class="lane-letter">{l["letter"]}</span>'
        f'<span class="lane-name">{html.escape(l["name"])}{star}</span>'
        f'<span class="lane-count"><span class="done">0</span>/{len(l["steps"])}</span>'
        f'</header>{note}<ol class="steps">{"".join(rows)}</ol></section>'
    )


chips = "".join(
    f'<a class="chip{" pri" if l["star"] else ""}" href="#lane-{l["letter"]}">'
    f'<b>{l["letter"]}</b><span>{html.escape(l["name"].split(" (")[0].split(" &")[0])}</span></a>'
    for l in lanes
)

lanes_html = "".join(lane_html(l) for l in lanes)

SETUP = [
    ("S-01", "✅ Done — Julia already holds <b>finance_admin</b> (2026-08-19)", "Lane F is unblocked"),
    ("S-02", "Grant a <b>refund_manager</b> who isn’t the requester", "Lane R needs two parties"),
    ("S-03", "✅ Done — flag verified 2026-08-19; UCG - Main is also now hidden from the member-facing Club Directory", "Lane R eligibility works"),
    ("S-04", "Confirm a <b>sanctioning</b> role exists somewhere", "Lane H needs a voter"),
    ("S-05", "Create a third, <b>role-less athlete</b> account", "Testing as admin hides every permission bug"),
    ("S-06", "Confirm email delivers to addresses you’ll actually read", "Lane E is worthless otherwise"),
    ("S-07", "Have a <b>second physical device</b> ready", "Lanes J, D and Z need it"),
    ("S-08", "✅ Nothing to do — the build stamp (v‹sha› · date) sits at the bottom of the nav, and in-app reports attach it automatically", "Findings pin to builds by themselves"),
]
setup_html = "".join(
    f'<li><span class="sid">{i}</span><div><p class="do">{t}</p>'
    f'<p class="exp"><span class="exp-label">Why</span>{w}</p></div></li>'
    for i, t, w in SETUP
)

CARDS = [
    ("4242 4242 4242 4242", "Succeeds"),
    ("4000 0025 0000 3155", "3-D Secure challenge"),
    ("4000 0000 0000 0002", "Declined"),
    ("4000 0000 0000 9995", "Insufficient funds"),
    ("4000 0000 0000 0259", "Succeeds, then disputes"),
]
cards_html = "".join(
    f'<li><code>{n}</code><span>{d}</span></li>' for n, d in CARDS)

SCHEDULE = [
    ("Day 1 AM", "A · M", "Both, separately", "2.5 h", True),
    ("Day 1 PM", "Z (joint) → E", "Together, then apart", "2 h", True),
    ("Day 2 AM", "G · W · K", "Julia leads", "2.5 h", True),
    ("Day 2 PM", "C · P", "Julia", "2 h", False),
    ("Day 3 AM", "H · N", "Julia + Nate", "2.5 h", False),
    ("Day 3 PM", "R · F", "Nate + Julia", "2 h", False),
    ("Day 4", "J · D · X · Y", "Both", "2.5 h", False),
]
sched_html = "".join(
    f'<tr{" class=pri" if p else ""}><td>{b}</td><td class="lanes-cell">{l}</td>'
    f'<td>{w}</td><td class="num">{t}</td></tr>'
    for b, l, w, t, p in SCHEDULE)

KNOWN = [
    ("Loading states aren’t announced to screen readers", "a11y audit A7 — deferred"),
    ("Empty states worded inconsistently (~30 variations)", "Deferred cleanup"),
    ("Two invoice-number formats coexist", "Known — but run <b>Z-01</b> anyway"),
    ("No nationals session-assignment tool (§L.2)", "Deliberately deferred by Julia"),
    ("Editing sessions can orphan registrations", "Known, related to the above"),
    ("New-club-request email isn’t wired up", "Known"),
    ("Receipts generated on demand, not attached to email", "Known deferral (§I)"),
    ("Schedule-file attachment on an event", "Not built — needs file storage"),
    ("PWA update path unverified", "That’s what <b>D-09</b> is for — please run it"),
    ("Nationals session-timed finals reminders", "Deliberately deferred"),
    ("Camps: club managers aren’t blocked — RESOLVED", "Julia chose “block it outright” (D-1); shipped 2026-08-19. <b>K-09</b> now verifies the block"),
    ("Synchro partner automations (reminder + jilted-revert emails)", "Not built — verified in code. Mutual auto-link IS built; <b>G-08</b> observes actual behavior"),
    ("Private registration code", "Not built — the field exists but nothing consumes it; the “Private reg link” button is a demo stub. Late reg = date window + auto fee (<b>G-16</b>)"),
    ("Season-preset on the membership gate link", "Not built — the page supports ?season= but nothing passes it (<b>G-01</b>)"),
]
known_html = "".join(
    f'<li><p class="do">{k}</p><p class="exp"><span class="exp-label">Status</span>{v}</p></li>'
    for k, v in KNOWN)

CONFIRM = [
    ("W-08", "Membership stuck after the club pays",
     "Told a guardian the membership “activates once their club pays” when the club had already paid — and it could never reach active through that path at all."),
    ("X-02 · X-03", "Public results hid posted scores",
     "Scores existed but didn’t render for registrations carrying no session id — and assigning sessions didn’t fix it."),
    ("J-04 · J-05 · J-06", "Judge unlock had no real rate limit",
     "40 simultaneous wrong codes were all merely refused, never throttled."),
]
confirm_html = "".join(
    f'<li><span class="sid">{s}</span><div><p class="do">{t}</p>'
    f'<p class="exp"><span class="exp-label">Used to</span>{d}</p></div></li>'
    for s, t, d in CONFIRM)

DECISIONS = [
    ("D-1 · Camps and club managers — <b>Block it outright</b>",
     "Answered 2026-08-19 and shipped the same day: camps no longer appear in the club-page event picker. K-09 verifies."),
    ("D-2 · Host payout timing — <b>Yes, 1 week after the event</b>",
     "The host-page wording is the policy."),
    ("D-3 · Hosts and SMS — <b>Email-only for hosts stays right</b>",
     "SMS remains league-admin-only."),
    ("D-4 · Invoice numbering — <b>Wipe before go-live; keep UCG-YYYY-XXXX</b>",
     "All current rows are test data. The Z-01 concurrency test still matters — the sequence fix stays a go-live gate."),
    ("D-5 · Add-on refunds — <b>Full refund until the add-on’s order deadline, none after</b>",
     "Not what’s built (code applies the 100%/75% registration rule to add-ons). Now an open item in whats-next; R-08/R-10 are annotated."),
    ("D-6 · Known gaps to prioritize — <b>Nothing at this time</b>", ""),
]
dec_html = "".join(
    f'<li><p class="do">{t}</p><p class="exp">{d}</p></li>' for t, d in DECISIONS)

SEV = [
    ("S1", "Blocker", "A core flow can’t complete, or money/data is wrong", "sev-1"),
    ("S2", "Major", "Broken or badly wrong, but there’s a workaround", "sev-2"),
    ("S3", "Minor", "Works, but wrong in a way a user would notice", "sev-3"),
    ("S4", "Polish", "Cosmetic", "sev-4"),
    ("Q", "Question", "You can’t tell whether it’s wrong", "sev-q"),
    ("D", "Decision", "Works as built — but is it what we want?", "sev-d"),
]
sev_html = "".join(
    f'<li class="{c}"><span class="sev-code">{k}</span>'
    f'<div><b>{n}</b><span>{d}</span></div></li>' for k, n, d, c in SEV)

page = f"""<title>UCG Preflight</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap">
<style>
:root {{
  /* UCG brand tokens (docs/specs/2026-07-08-ucg-rebrand.md). Every pair below
     was contrast-checked before publish; see the comments for measured ratios. */
  --ground:  #DBEBEE;   /* Light Blue */
  --surface: #FCFCFC;
  --sunk:    #EAF3F5;
  --ink:     #1E2B38;   /* Navy — 11.75:1 on ground, 14.04:1 on surface */
  --soft:    #5A6A78;   /* 5.43:1 on surface, 4.55:1 on ground */
  --accent:  #BD3F27;   /* coral-text — surfaces ONLY (4.39:1 on ground = large text only) */
  --fill:    #F4694A;   /* Red Orange — a FILL. Navy text on it = 4.78:1 */
  --on-fill: #1E2B38;
  --id:      #184B56;   /* Dark Blue Green — 9.39:1 on surface */
  --rule:    #C8D8DB;
  --rule-soft: #DDE8EA;
  --warn-bg: #FAEBBC;   /* gold-100 — navy on it = 12.12:1 */
  --warn-ink:#1E2B38;
  --warn-edge:#E6C453;
  --chip-bg: #FFFFFF;
  --mast-bg:   #1E2B38;   /* fixed in BOTH themes - a band, not a surface */
  --mast-ink:  #FCFCFC;   /* 14.04:1 on --mast-bg */
  --mast-soft: #C6D6DC;   /* 9.64:1 */
  --mast-meta: #A5C8CF;   /* 8.07:1 */
  --mast-rule: #34434F;   /* hairline divider, decorative */
  --shadow: 0 1px 2px rgba(20,32,44,.06), 0 10px 28px -18px rgba(20,32,44,.35);
  --maxw: 62rem;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --ground:  #10191F;
    --surface: #1A2731;
    --sunk:    #16222B;
    --ink:     #E4EEF1;  /* 15.07:1 on ground, 12.91:1 on surface */
    --soft:    #9DB0BC;  /* 6.80:1 on surface */
    --accent:  #F4694A;  /* 5.05:1 on surface, 5.90:1 on ground */
    --fill:    #F4694A;
    --on-fill: #1E2B38;
    --id:      #A5C8CF;  /* 8.53:1 on surface */
    --rule:    #2E3E4A;
    --rule-soft: #24323C;
    --warn-bg: #33291024;
    --warn-ink:#F6C328;  /* 9.25:1 on surface */
    --warn-edge:#6B5A22;
    --chip-bg: #1A2731;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px -18px rgba(0,0,0,.8);
  }}
}}
:root[data-theme="dark"] {{
  --ground:  #10191F;
  --surface: #1A2731;
  --sunk:    #16222B;
  --ink:     #E4EEF1;
  --soft:    #9DB0BC;
  --accent:  #F4694A;
  --fill:    #F4694A;
  --on-fill: #1E2B38;
  --id:      #A5C8CF;
  --rule:    #2E3E4A;
  --rule-soft: #24323C;
  --warn-bg: #33291024;
  --warn-ink:#F6C328;
  --warn-edge:#6B5A22;
  --chip-bg: #1A2731;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px -18px rgba(0,0,0,.8);
}}

* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: 'Instrument Sans', 'Helvetica Neue', Arial, sans-serif;
  font-size: 16px;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
}}
.wrap {{ max-width: var(--maxw); margin: 0 auto; padding: 0 1.25rem 5rem; }}
code {{
  font-family: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  font-size: .88em; background: var(--sunk); padding: .1em .35em;
  border-radius: 4px; border: 1px solid var(--rule-soft);
}}
strong {{ font-weight: 700; }}
a {{ color: var(--accent); }}
:focus-visible {{ outline: 3px solid var(--fill); outline-offset: 2px; border-radius: 4px; }}

/* ---------------------------------------------------------------- masthead */
.mast {{
  background: var(--mast-bg); color: var(--mast-ink);
  padding: 2.75rem 0 2.25rem; margin-bottom: 0;
}}
.mast .wrap {{ padding-bottom: 0; }}
.eyebrow {{
  font-family: 'IBM Plex Mono', monospace; font-size: .72rem; font-weight: 600;
  letter-spacing: .16em; text-transform: uppercase; color: var(--fill);
  margin: 0 0 .85rem;
}}
h1 {{
  font-family: Anton, 'Arial Narrow', Impact, sans-serif; font-weight: 400;
  font-size: clamp(2.6rem, 9vw, 4.6rem); line-height: .92; letter-spacing: .005em;
  text-transform: uppercase; margin: 0 0 1rem; text-wrap: balance; color: var(--mast-ink);
}}
.mast p {{ margin: 0; max-width: 46ch; color: var(--mast-soft); font-size: 1.02rem; }}
.mast-meta {{
  display: flex; flex-wrap: wrap; gap: .5rem 1.6rem; margin-top: 1.6rem;
  padding-top: 1.25rem; border-top: 1px solid var(--mast-rule);
  font-family: 'IBM Plex Mono', monospace; font-size: .78rem; color: var(--mast-meta);
}}
.mast-meta b {{ color: var(--mast-ink); font-weight: 600; }}

/* ------------------------------------------------------------------ rails */
.rail {{
  position: sticky; top: 0; z-index: 30; background: var(--ground);
  border-bottom: 1px solid var(--rule); padding: .6rem 0;
  box-shadow: 0 6px 16px -14px rgba(20,32,44,.6);
}}
.rail-inner {{
  max-width: var(--maxw); margin: 0 auto; padding: 0 1.25rem;
  display: flex; gap: .6rem; align-items: center;
}}
#filter {{
  flex: 1 1 auto; min-width: 0; font: inherit; font-size: .92rem;
  padding: .5rem .8rem; border-radius: 8px; border: 1px solid var(--rule);
  background: var(--surface); color: var(--ink);
}}
#filter::placeholder {{ color: var(--soft); }}
.filter-count {{
  font-family: 'IBM Plex Mono', monospace; font-size: .76rem; color: var(--soft);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}}
.chips {{
  display: flex; gap: .4rem; overflow-x: auto; padding: .55rem 1.25rem .1rem;
  max-width: var(--maxw); margin: 0 auto; scrollbar-width: thin;
}}
.chip {{
  flex: 0 0 auto; display: inline-flex; align-items: baseline; gap: .4rem;
  background: var(--chip-bg); border: 1px solid var(--rule); border-radius: 999px;
  padding: .3rem .75rem; text-decoration: none; color: var(--ink); font-size: .8rem;
}}
.chip b {{ font-family: 'IBM Plex Mono', monospace; font-weight: 600; color: var(--id); }}
.chip.pri {{ border-color: var(--fill); }}
.chip.pri b {{ color: var(--accent); }}
.chip:hover {{ border-color: var(--fill); }}

/* ------------------------------------------------------------------ blocks */
section.block {{
  background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
  padding: 1.6rem 1.5rem; margin: 1.5rem 0; box-shadow: var(--shadow);
}}
h2 {{
  font-family: Anton, 'Arial Narrow', Impact, sans-serif; font-weight: 400;
  text-transform: uppercase; letter-spacing: .015em;
  font-size: clamp(1.35rem, 3.6vw, 1.9rem); line-height: 1.05;
  margin: 0 0 .35rem; text-wrap: balance;
}}
h3 {{ font-size: 1rem; margin: 1.5rem 0 .5rem; letter-spacing: .01em; }}
.lede {{ color: var(--soft); margin: 0 0 1.15rem; max-width: 62ch; }}
.block > p, .block > ul, .block > ol {{ max-width: 68ch; }}

.rules {{ list-style: none; margin: 0; padding: 0; display: grid; gap: .85rem; }}
.rules > li {{
  display: grid; grid-template-columns: 1.6rem 1fr; gap: .75rem;
  padding-bottom: .85rem; border-bottom: 1px solid var(--rule-soft);
}}
.rules > li:last-child {{ border-bottom: 0; padding-bottom: 0; }}
.rules .n {{
  font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: .82rem;
  color: var(--accent); padding-top: .12rem;
}}
.rules p {{ margin: 0; }}
.rules .sub {{ color: var(--soft); font-size: .93rem; margin-top: .2rem; }}

/* --------------------------------------------------------------- step list */
.lane {{
  background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
  margin: 1.25rem 0; overflow: hidden; box-shadow: var(--shadow); scroll-margin-top: 6.5rem;
}}
.lane-head {{
  display: flex; align-items: center; gap: .75rem;
  background: var(--fill); color: var(--on-fill); padding: .6rem .9rem;
}}
.lane-letter {{
  font-family: Anton, Impact, sans-serif; font-size: 1.5rem; line-height: 1;
  width: 1.5rem; text-align: center;
}}
.lane-name {{ font-weight: 700; font-size: 1rem; flex: 1 1 auto; letter-spacing: .01em; }}
.star {{ margin-left: .4rem; }}
.lane-count {{
  font-family: 'IBM Plex Mono', monospace; font-size: .78rem; font-weight: 600;
  font-variant-numeric: tabular-nums; opacity: .82;
}}
.lane-note {{
  margin: 0; padding: .7rem .9rem; background: var(--sunk); color: var(--soft);
  font-size: .89rem; border-bottom: 1px solid var(--rule-soft);
}}
ol.steps, ul.plain {{ list-style: none; margin: 0; padding: 0; }}
.step {{
  display: grid; grid-template-columns: 5.4rem 1fr; gap: .1rem .5rem;
  padding: .7rem .9rem .75rem; border-bottom: 1px solid var(--rule-soft);
}}
.step:last-child {{ border-bottom: 0; }}
.step.flagged {{ background: var(--warn-bg); border-left: 3px solid var(--warn-edge); }}
.step.flagged .exp {{ color: var(--warn-ink); }}
.mark {{
  display: flex; align-items: center; gap: .45rem; background: none; border: 0;
  padding: .1rem 0 0; margin: 0; cursor: pointer; font: inherit;
  align-self: start; min-height: 32px;
}}
.mark-box {{
  width: 15px; height: 15px; flex: 0 0 auto; border: 1.5px solid var(--rule);
  border-radius: 4px; background: var(--surface);
}}
.mark[aria-pressed="true"] .mark-box {{ background: var(--fill); border-color: var(--fill); }}
.mark[aria-pressed="true"] .sid {{ opacity: .5; }}
.sid {{
  font-family: 'IBM Plex Mono', monospace; font-size: .8rem; font-weight: 600;
  color: var(--id); letter-spacing: -.01em; white-space: nowrap;
}}
.step-body p {{ margin: 0; }}
.do {{ font-weight: 500; }}
.exp {{ color: var(--soft); font-size: .93rem; margin-top: .22rem !important; }}
.exp-label {{
  font-family: 'IBM Plex Mono', monospace; font-size: .64rem; font-weight: 600;
  letter-spacing: .1em; text-transform: uppercase; color: var(--accent);
  margin-right: .45rem;
}}

/* setup / confirm / known lists reuse the step grid */
ul.plain > li {{
  display: grid; grid-template-columns: 5.4rem 1fr; gap: .1rem .5rem;
  padding: .7rem 0; border-bottom: 1px solid var(--rule-soft);
}}
ul.plain > li:last-child {{ border-bottom: 0; }}
ul.stack > li {{ display: block; padding: .7rem 0; border-bottom: 1px solid var(--rule-soft); }}
ul.stack > li:last-child {{ border-bottom: 0; }}

/* --------------------------------------------------------------- severity */
ul.sev {{ list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }}
ul.sev > li {{ display: grid; grid-template-columns: 2.4rem 1fr; gap: .7rem; align-items: start; }}
.sev-code {{
  font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: .8rem;
  text-align: center; padding: .12rem 0; border-radius: 5px;
  background: var(--sunk); border: 1px solid var(--rule); color: var(--ink);
}}
.sev-1 .sev-code {{ background: var(--fill); border-color: var(--fill); color: var(--on-fill); }}
.sev-2 .sev-code {{ background: #F6C328; border-color: #E0AF17; color: #1E2B38; }}
.sev-d .sev-code {{ background: #ADBAE9; border-color: #96A6E0; color: #1E2B38; }}
ul.sev b {{ display: inline-block; margin-right: .5rem; }}
ul.sev span:not(.sev-code) {{ color: var(--soft); font-size: .93rem; }}

/* ------------------------------------------------------------------ tables */
.scroller {{ overflow-x: auto; margin: .5rem 0 0; }}
table {{ border-collapse: collapse; width: 100%; font-size: .92rem; min-width: 30rem; }}
th, td {{ text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--rule-soft); }}
th {{
  font-family: 'IBM Plex Mono', monospace; font-size: .7rem; font-weight: 600;
  letter-spacing: .09em; text-transform: uppercase; color: var(--soft);
  border-bottom: 1px solid var(--rule);
}}
td.num {{ font-variant-numeric: tabular-nums; white-space: nowrap; }}
.lanes-cell {{ font-family: 'IBM Plex Mono', monospace; font-weight: 600; color: var(--id); }}
tr.pri td:first-child {{ box-shadow: inset 3px 0 0 var(--fill); font-weight: 600; }}

ul.cards {{ list-style: none; margin: .4rem 0 0; padding: 0; display: grid; gap: .4rem; }}
ul.cards > li {{ display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: baseline; }}
ul.cards code {{ font-size: .95rem; letter-spacing: .02em; }}
ul.cards span {{ color: var(--soft); font-size: .9rem; }}

.callout {{
  background: var(--warn-bg); border: 1px solid var(--warn-edge); border-left-width: 4px;
  border-radius: 8px; padding: .9rem 1rem; margin: 1rem 0; color: var(--warn-ink);
}}
.callout p {{ margin: 0; }}
.callout p + p {{ margin-top: .5rem; }}

.foot {{ color: var(--soft); font-size: .9rem; margin-top: 2.5rem; text-align: center; }}

@media (max-width: 560px) {{
  .step, ul.plain > li {{ grid-template-columns: 1fr; }}
  .mark {{ margin-bottom: .1rem; }}
  section.block {{ padding: 1.25rem 1.1rem; }}
  .rules > li {{ grid-template-columns: 1.4rem 1fr; }}
}}
@media (prefers-reduced-motion: reduce) {{
  * {{ animation: none !important; transition: none !important; scroll-behavior: auto !important; }}
}}
</style>

<header class="mast">
  <div class="wrap">
    <p class="eyebrow">Pre-launch validation · 2026-08-19</p>
    <h1>UCG Preflight</h1>
    <p>Every shipped feature, walked end to end by the two people who know what it was
       supposed to do. {total_steps} steps across {len(lanes)} lanes.</p>
    <div class="mast-meta">
      <span>Testers <b>Nate · Julia</b></span>
      <span>Target <b>production</b></span>
      <span>Stripe <b>test mode</b></span>
      <span>Steps <b>{total_steps}</b></span>
    </div>
  </div>
</header>

<nav class="rail" aria-label="Find a step">
  <div class="rail-inner">
    <input id="filter" type="search" placeholder="Filter steps — try “refund”, “M-07”, “email”" aria-label="Filter steps">
    <span class="filter-count" id="count">{total_steps} steps</span>
  </div>
  <div class="chips">{chips}</div>
</nav>

<div class="wrap">

<section class="block">
  <h2>Read this first</h2>
  <p class="lede">Eight things that change what the rest of this is worth.</p>
  <ol class="rules">
    <li><span class="n">01</span><div><p><strong>Test on production.</strong> Stripe is in test mode, so no real money can move. Staging isn’t a substitute — every staging payment is <code>failed</code>/<code>pending</code>, so money surfaces legitimately read <strong>$0</strong> there and can’t prove arithmetic.</p></div></li>
    <li><span class="n">02</span><div><p><strong>Prefix everything you create with <code>ZZTEST-</code>.</strong> People, clubs, events, banner text.</p><p class="sub">Two people stress-testing add a lot of rows to production. The pre-launch sweep needs to be a search, not an excavation. Forgot? Say so in Notes.</p></div></li>
    <li><span class="n">03</span><div><p><strong>File broken things in-app, immediately</strong> — before navigating away.</p><p class="sub">“Report a problem” captures the route, the build SHA, and a ring buffer of recent console errors. That buffer is overwritten as you keep clicking.</p></div></li>
    <li><span class="n">04</span><div><p><strong>Hard-reload once before filing “it didn’t update.”</strong></p><p class="sub">Live updates are wired for <em>scores only</em>. Most other cross-device changes legitimately need a refresh — which is why the sheet has a column for it.</p></div></li>
    <li><span class="n">05</span><div><p><strong>Record the local time</strong> of anything that misbehaves — that’s what correlates a finding to the server logs.</p></div></li>
    <li><span class="n">06</span><div><p><strong>“Missing” is a finding.</strong> If a step describes something that doesn’t exist, mark it <code>MISSING</code>. Known deferrals are listed below so you don’t waste time; anything else missing is worth knowing.</p></div></li>
    <li><span class="n">07</span><div><p><strong>Disagreeing with the design is a finding too.</strong></p><p class="sub">Julia especially — if something works but isn’t what you meant when you wrote the requirement, that’s the most valuable feedback here, and far cheaper now than after launch. Mark it <code>D</code>, not a bug.</p></div></li>
    <li><span class="n">08</span><div><p><strong>Don’t fix each other’s findings mid-session.</strong> One person’s workaround hides a bug from the other.</p></div></li>
  </ol>
</section>

<section class="block" id="setup">
  <h2>Setup</h2>
  <p class="lede">Nate, ~30 minutes. These otherwise dead-end whole lanes — three are already open items on the what’s-next list.</p>
  <ul class="plain">{setup_html}</ul>
  <h3>Stripe test cards — use more than 4242</h3>
  <ul class="cards">{cards_html}</ul>
</section>

<section class="block" id="feedback">
  <h2>How to send feedback</h2>
  <p class="lede">Two channels. Use the wrong one and either the evidence or the structure is lost.</p>

  <h3>Channel 1 — in-app “Report a problem”, for anything broken</h3>
  <p>Start the description with the finding ID and your initials, blank line, then prose. Paste screenshots straight into the box (Win+Shift+S then Ctrl+V, or Cmd+Shift+4 then Cmd+V). Then add <em>one</em> row in your sheet with the same ID — don’t retype the description.</p>

  <h3>Channel 2 — the shared Google Sheet, for everything including passes</h3>
  <p>The Sheet is the coverage record — it answers “did anyone actually try this?”, which the in-app reports can’t. Fill a Result for <strong>every</strong> step; a PASS takes two seconds and is what makes the untested gaps visible. It’s also the only channel for UX feedback, wording, “works but wrong”, and requirement disagreements.</p>
  <div class="callout"><p><strong>One shared Google Sheet — <a href="https://docs.google.com/spreadsheets/d/1tBHmut8OCmJXrcH3zaY0g0_GcHvj0T44DDfu1YAIcq0/edit" target="_blank" rel="noopener">UCG Preflight Feedback</a>.</strong> A Findings tab per tester (Julia&nbsp;Findings / Nate&nbsp;Findings), all 240 steps pre-filled with dropdowns, plus README and the answered Decisions tab. Work only in your own tab.</p></div>

  <h3>IDs and screenshots</h3>
  <p>Step ID is <code>LANE-NN</code> (<code>M-07</code>). Finding ID adds a sequence — <code>M-07-01</code>. Something not tied to a step uses <code>X</code>: <code>M-X-01</code>.</p>
  <p>Screenshot filename: <code>&lt;finding ID&gt;_&lt;seq&gt;_&lt;initials&gt;.png</code> → <code>M-07-01_01_JB.png</code>. Include the address bar; annotate the exact element; use a screen <em>recording</em> for anything with motion; for money bugs capture the line items <em>and</em> the total in one frame. One flat folder each.</p>

  <h3>Severity</h3>
  <ul class="sev">{sev_html}</ul>
  <h3>Result codes</h3>
  <p><code>PASS</code> · <code>FAIL</code> · <code>MISSING</code> (doesn’t exist) · <code>UNCLEAR</code> (couldn’t tell) · <code>BLOCKED</code> (couldn’t reach it) · <code>N/A</code></p>
</section>

<section class="block" id="schedule">
  <h2>Suggested schedule</h2>
  <p class="lede">Lanes are independent — reorder freely. But <strong>Z must be booked as a joint session</strong>, and <strong>M before R</strong> (a refund needs something paid).</p>
  <div class="scroller"><table>
    <thead><tr><th>Block</th><th>Lanes</th><th>Who</th><th>Time</th></tr></thead>
    <tbody>{sched_html}</tbody>
  </table></div>
  <div class="callout"><p><strong>Only have three hours?</strong> Do the starred rows — A, M, Z and the first half of G. That covers every path where a defect costs real money or blocks a real registration.</p></div>
</section>

{lanes_html}

<section class="block" id="known">
  <h2>Known gaps — please don’t file these</h2>
  <p class="lede">Already tracked. Confirming them costs nothing; filing them costs a triage cycle. If you think one should be prioritized, say so — that part <em>is</em> useful.</p>
  <ul class="stack">{known_html}</ul>
</section>

<section class="block" id="confirm">
  <h2>Three fixes no human has watched work</h2>
  <p class="lede">Each was root-caused, fixed, and proven by scripted tests against the live backend — but only by automation. Each was also a case where the obvious reading of the bug turned out to be wrong, which is why a human look is worth it.</p>
  <ul class="plain">{confirm_html}</ul>
</section>

<section class="block" id="decisions">
  <h2>Decisions — all answered</h2>
  <p class="lede">Julia answered all six on 2026-08-19. Recorded here and in the Sheet’s Decisions tab; follow-ups are tracked in whats-next.</p>
  <ul class="stack">{dec_html}</ul>
</section>

<p class="foot">Findings go straight into the shared Sheet; send a zipped screenshot folder after each block — partial is genuinely useful.<br>
A completed lane A + M beats four half-finished lanes.</p>
</div>

<script>
(function () {{
  var KEY = 'ucg-preflight-marks';
  var marks = {{}};
  try {{ marks = JSON.parse(localStorage.getItem(KEY) || '{{}}'); }} catch (e) {{ marks = {{}}; }}

  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));

  function refreshCounts() {{
    document.querySelectorAll('.lane').forEach(function (lane) {{
      var all = lane.querySelectorAll('.step');
      var n = 0;
      all.forEach(function (s) {{ if (marks[s.dataset.id]) n++; }});
      var el = lane.querySelector('.lane-count .done');
      if (el) el.textContent = n;
    }});
  }}

  steps.forEach(function (step) {{
    var btn = step.querySelector('.mark');
    if (!btn) return;
    if (marks[step.dataset.id]) btn.setAttribute('aria-pressed', 'true');
    btn.addEventListener('click', function () {{
      var on = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', on ? 'false' : 'true');
      if (on) delete marks[step.dataset.id]; else marks[step.dataset.id] = 1;
      try {{ localStorage.setItem(KEY, JSON.stringify(marks)); }} catch (e) {{}}
      refreshCounts();
    }});
  }});
  refreshCounts();

  var input = document.getElementById('filter');
  var count = document.getElementById('count');
  var total = steps.length;

  function apply() {{
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    steps.forEach(function (s) {{
      var hit = !q || s.textContent.toLowerCase().indexOf(q) !== -1;
      s.hidden = !hit;
      if (hit) shown++;
    }});
    document.querySelectorAll('.lane').forEach(function (lane) {{
      var any = lane.querySelector('.step:not([hidden])');
      lane.hidden = !!q && !any;
    }});
    count.textContent = q ? shown + ' of ' + total : total + ' steps';
  }}
  input.addEventListener('input', apply);
}})();
</script>
"""

open(OUT, "w", encoding="utf-8").write(page)
print("wrote", OUT, len(page), "bytes")
