"""Build the UAT feedback tracker workbooks for Nate and Julia.

One workbook each (parallel edits to a shared file conflict and lose rows).
Sheets: README (legend + live progress counters), Findings (240 pre-filled step
rows + blank overflow), Decisions (Appendix C), Lists (dropdown sources).
"""
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

FONT = "Arial"

# ---------------------------------------------------------------- step catalog
# (lane letter, lane name, [(nn, short label), ...])
LANES = [
    ("A", "Accounts, auth & security", [
        "Sign up a brand-new account from scratch",
        "Signed out: go directly to #/admin/league",
        "Role-less athlete: try the 3 admin routes (watch for a flash of real UI)",
        "Refresh 3x while on an admin page as admin (no access-denied flash)",
        "Sign out, then press browser Back",
        "Forgot-password flow end to end",
        "Admin sends an account invite; recipient sets a password",
        "Enroll TOTP with a real authenticator app",
        "Sign out, sign back in with TOTP (wrong code, then right)",
        "Enroll a passkey on real hardware; sign in with it",
        "Sign in as an admin with no MFA enrolled (the nag)",
        "Nate: admin MFA reset break-glass",
        "Visit #/profile (a route that does not exist)",
        "Signed in on phone + desktop; change name on one",
    ]),
    ("M", "Cart, pricing & Stripe checkout", [
        "Add one registration to cart; write down every number",
        "Compare the Stripe page's numbers against the cart, to the cent",
        "Pay with 4242; watch what happens after",
        "Confirmation email vs the in-app receipt",
        "Open the receipt PDF and actually print it",
        "Checkout with the DECLINE card 4000...0002",
        "Checkout with the 3-D SECURE card 4000 0025 0000 3155",
        "Start a checkout and abandon it (close the tab mid-payment)",
        "Browser Back button from inside Stripe checkout",
        "Cart with registration + add-ons + a change fee together",
        "Apply a promo/coupon code (visible in cart AND in Stripe)",
        "Coupon that covers 100% of the total",
        "Invalid coupon, then an expired coupon",
        "Remove a cart line for a NEW registration",
        "Remove a cart line for a CHANGE FEE (does it roll back?)",
        "Club cart: Print Invoice BEFORE paying",
        "Service fee across several totals vs Stripe's actual fee",
        "Personal cart and a club cart populated at once",
        "#/me/purchases: dates in local timezone, receipts download",
        "#/me/purchases vs the Stripe Dashboard test payments",
    ]),
    ("Z", "Two-person concurrency (JOINT)", [
        "SIMULTANEOUS CHECKOUT x3 - record BOTH invoice numbers verbatim",
        "Both register the SAME athlete for the SAME event at once",
        "Both fill the last capacity slots at once",
        "Both approve the SAME refund request at once",
        "Both save different changes to the same event settings",
        "Both enter a different score for the same athlete/apparatus",
    ]),
    ("E", "Email & SMS deliverability", [
        "Trigger all 13 transactional emails; check arrival/spam/from/reply-to/phone",
        "Per-event custom confirmation email body",
        "Event from-alias + reply-to (hit Reply and see where it goes)",
        "CC the director on a confirmation",
        "Admin Communicate: email a filtered group",
        "Admin Communicate: test send",
        "Event Communicate as a HOST (email yes, SMS admin-only by design)",
        "Event Communicate: filter by session / level / discipline",
        "Send an SMS to yourself; reply to it",
        "Reply STOP, then try to send again",
        "Sent log after the email and SMS sends",
        "Open the 3 most important emails on a PHONE",
        "Did anything land in spam or Promotions?",
    ]),
    ("G", "Athlete self-service registration", [
        "Non-member tries to register (season-targeted membership link?)",
        "Buy the membership through that link, return, register",
        "Register while signed out (does it return you to the event?)",
        "Registration popup: disciplines, level, apparatus, all-around",
        "T&T: multiple disciplines with per-apparatus levels",
        "T&T: try to remove your LAST remaining discipline",
        "Synchro: pick a partner from the member list",
        "Have your partner pick someone else (jilted-athlete email?)",
        "Add-ons in the popup: banquet / t-shirt / leo / banner",
        "Banquet: buy 2 for yourself (max 1 ASSIGNED to you)",
        "Survey questions come LAST, after add-ons",
        "#/me/registrations shows everything incl. add-ons + survey",
        "Edit a COMPETITION detail after paying (change fee applies)",
        "Edit an ADD-ON or SURVEY answer after paying (NO change fee)",
        "Try to edit after the change deadline",
        "Register with a late-registration code (late fee on top)",
        "Use that code AFTER lastDateToEdit (should stop working)",
        "Copy-link button; open the link in incognito",
        "Register for an event in a different timezone",
        "Request a refund on one of your registrations (self-serve)",
    ]),
    ("W", "Membership & waivers", [
        "Buy an athlete membership end to end",
        "Buy a coach membership",
        "Sign the waiver inline during purchase",
        "Sign via the emailed direct link as an adult",
        "Guardian path: minor's membership -> guardian waiver request",
        "Try signing with the WRONG name on the direct link",
        "Club-paying membership while the club cart is UNPAID",
        "*** Same membership AFTER the club pays (see Appendix B) ***",
        "Membership with BOTH a waiver hold and a club-payment hold",
        "Admin: who signed which waiver version",
        "Publish a new waiver version; check an existing signature",
        "Buy a membership for a past/future season",
    ]),
    ("K", "Camps", [
        "Register for a camp (no discipline/level/apparatus step)",
        "Camp registration WITHOUT a club membership (should be allowed)",
        "Camp registration WITHOUT an individual membership (should block)",
        "Overnight survey: bedtime / noise / cabin gender / roommate",
        "Edit the survey after registering (free, no change fee)",
        "Camp add-ons: size required, $0 allowed, explicit 'no shirt/leo'",
        "Camp confirmation email: survey + add-ons + edit link",
        "Camp export: 1 line per athlete with all the spec'd columns",
        "*** DECISION: can a club manager register athletes for a camp? ***",
        "Edit a camp registration made before 2026-07-23 (if any exist)",
    ]),
    ("C", "Club manager", [
        "Roster: add, edit, remove an athlete",
        "Send a club invite; accept it from the other side",
        "Status bubbles: Registered / In Cart / Pending Changes / Updated",
        "Swap an athlete in an existing registration (change fee applies)",
        "Register several athletes at once; check out as the club",
        "Add-ons: assign banquet tickets to athletes and to EXTRA",
        "T-shirts/leos: quantity + size PER UNIT",
        "Club banner: 1 per club, exact-name text box",
        "Members-without-membership card + 'last sent [date]'",
        "'Create new athlete' from that card",
        "Set Competition Order (MAG/WAG; 12 WAG / 15 MAG per section)",
        "Admin locks competition orders; club becomes view-only",
        "Try to view ANOTHER club's roster by editing the URL",
        "Per-line refund request from the registered-athletes card",
        "Club Cart & Receipts: past receipts, separate from personal",
    ]),
    ("P", "Capacity, waitlists & by-session", [
        "Total participant cap; fill it",
        "Per-level cap (WAG/MAG) - counts ROUTINES, not athletes",
        "Per-discipline cap (T&T)",
        "PARTIAL FIT: 2 spots left, try to register 3",
        "Choose 'waitlist the whole group'",
        "Free up space; does the waitlist auto-notify?",
        "Admin overrides a cap for one case",
        "Switch to BY-SESSION mode; create sessions with routine caps",
        "Try to register into a FULL session",
        "Checkout when the selected session lacks space",
        "Edit a registration to move sessions",
        "Change level to one that doesn't fit the session",
        "Abandon a checkout; wait ~30 min for the soft hold to release",
    ]),
    ("H", "Sanctioning & event hosting", [
        "Submit a sanction request with the full field set",
        "Vote on it from the sanctioning queue",
        "Approve it (event auto-created, YYYY_ST_### id, email)",
        "Reject a different request",
        "Voting reminder emails at 3 days and 1 day before deadline",
        "Assign an event owner (unassigned = red highlight?)",
        "Event-owner checklist: all 7 items with sane due dates",
        "Let a checklist item go overdue (escalating emails?)",
        "Event wizard: fill EVERY field, save, reload",
        "Try to upload a schedule attachment (known gap - confirm)",
        "Event Host page status card",
        "Host page payment status with real paid registrations",
        "Host page registration summary (per level, clubs, apparatus)",
        "Host page Excel download - open it in Excel",
        "Event admin grant by exact account email",
        "Sign in as the granted account (that event only)",
        "Post-close host edits (with warning; never refunds/pricing)",
        "Event status transitions: draft -> published -> open -> closed",
        "'Publish dates and location only' (no Details button)",
    ]),
    ("N", "Nationals", [
        "Session-request survey: per WAG level, all MAG, all T&T",
        "Try to check out the event cart with a survey unanswered",
        "Independent athlete variant of the survey",
        "Edit a survey answer before the change deadline",
        "Eligible teams table (>=3 athletes per apparatus)",
        "Placement categories vs the gender/override/student matrix",
        "Finals lineup editor: pick 4 per apparatus, drag to order",
        "finals_lineup_deadline_at nag as the deadline approaches",
        "10pm hard lock (clubs view-only, admins can edit)",
        "Decathlon / omnithon summary",
        "Club coach list (+ warning when a club has none)",
        "Banquet-ticket gap list",
        "Assigned-sessions table, incl. '(partial)'",
        "Check-in flow end to end",
        "Check-in page athlete count = athlete-gift count",
        "Admin views the check-in page AS another club / athlete",
        "Nationals scoring: quals + awards; check one placement by hand",
    ]),
    ("R", "Refunds", [
        "Request a refund on a NON-UCG-hosted event (should be unavailable)",
        "Request one on a UCG-hosted event BEFORE lastDateToEdit",
        "Approve it (full refund, registration removed, receipt)",
        "Verify the refund in the Stripe Dashboard",
        "Request + approve one AFTER lastDateToEdit (75% before fees)",
        "After-deadline athlete: apparatus unchecked + un-recheckable",
        "REJECT a request (email, refund admins cc'd, no reg change)",
        "Refund a single banquet ticket",
        "Move a banquet ticket to another athlete / mark EXTRA",
        "Refund one add-on; confirm the ORIGINAL receipt is undisturbed",
        "Refund a CLUB-PAID registration (refunds to the club)",
        "Refund an order a coupon covered 100%",
        "Request more than remains refundable",
        "#/admin/finance reflects every refund above",
    ]),
    ("F", "Finance & admin", [
        "Julia opens #/admin/finance as finance_admin (NOT admin)",
        "Summary tab: revenue types with accounting codes",
        "Check the arithmetic by hand vs Stripe for one day",
        "Date-range filter, incl. the smart defaults",
        "Per-event finance dashboard",
        "Host payout: amount owed + the calculation shown",
        "Enter host payment info (date, check# / PayPal / ACH)",
        "Invoices/Transactions tab: full detail per row",
        "Click through from a summary line to its transactions",
        "Export both tabs; open in Excel",
        "Accounting-code management",
        "#/admin/members: search, edit, export a person, delete a person",
        "#/admin/clubs: create, edit, manage managers",
        "#/admin/league: seasons, levels, regions, promos, waivers, roles",
        "Grant then REVOKE a role; have that person refresh",
        "#/admin/errors - correlate one against your timestamp column",
        "Payments reconciliation tool",
        "Manager-access request -> review flow",
    ]),
    ("J", "Judge & meet day (2 devices)", [
        "Generate a judge access code for a live event",
        "Device 2, signed out: SCAN THE QR WITH A REAL CAMERA",
        "Device 2: unlock with the 6-digit code",
        "*** Enter ~16 wrong codes: rate-limited after 15? (Appendix B) ***",
        "After the lockout, unlock with the URL/QR token instead",
        "After a successful unlock, try a few bad codes again",
        "Enter a real score from the anonymous device",
        "Watch it appear on device 1 WITHOUT refreshing",
        "Calculator entry mode - check the math by hand",
        "Simple entry mode",
        "2-judge panel: execution scores averaged",
        "Score every discipline you support (MAG, WAG, T&T, specialty)",
        "Edit a posted score (updates public results too?)",
        "Open a score detail page",
        "Score entry with no unlock and no privileged account",
        "Judge on a phone in landscape, one-handed, venue wifi",
        "Turn wifi off mid-entry, then back on",
    ]),
    ("X", "Public & anonymous (incognito)", [
        "Public Results index + an event's results (names visible?)",
        "*** Results for an event with scores across sessions (Appendix B) ***",
        "*** Results where some regs have NO session assigned ***",
        "Public Events list + an event detail page",
        "Home page while signed out",
        "Try #/me, #/cart, #/admin/members while signed out",
        "Open a judge access URL you weren't given",
        "Share an event link to yourself and open it from there",
        "Public pages on a phone",
    ]),
    ("D", "Devices, responsive & PWA", [
        "Full pass on an iPhone (Safari)",
        "Full pass on an Android (Chrome)",
        "Tablet, both orientations",
        "Mobile nav drawer: open, navigate, close",
        "Every modal on a phone",
        "Wide tables on a phone (scroll inside, not the page)",
        "Install the PWA on iOS and Android",
        "Full registration flow inside the installed PWA",
        "*** PWA UPDATE PATH: reopen after the next deploy; note the delay ***",
        "OS dark mode - flag any text you can barely see",
        "Browser zoom to 200%",
        "Rotate the phone mid-form",
        "Firefox and Edge, one flow each",
    ]),
    ("Y", "Keyboard & accessibility", [
        "UNPLUG THE MOUSE: full registration + checkout by keyboard only",
        "Is the focus ring always visible when tabbing?",
        "*** Press ENTER and SPACE on buttons - never verified by a human ***",
        "Open a modal, Tab repeatedly (focus must stay inside)",
        "Escape in a modal with unsaved changes",
        "Escape with two dialogs stacked",
        "Close a modal - does focus return to what opened it?",
        "Tab order on a long form (Profile)",
        "Squint-test every screen for low-contrast text",
        "VoiceOver/Narrator skim of the Profile page (if available)",
    ]),
]

DECISIONS = [
    ("D-1", "Camps and club managers",
     "Spec SS-G says camps are individual self-registration only, but a club manager can still "
     "register athletes for one. Block it outright, or keep it as a convenience?"),
    ("D-2", "Host payout timing",
     "The 'owed' formula is settled (gross before fees, refunds not deducted). WHEN payout "
     "happens is still just wording on the host page. Is '1 week after the event' the policy?"),
    ("D-3", "Hosts and SMS",
     "Hosts currently get email only from the event Communicate page; SMS stays league-admin-only "
     "because each text bills UCG. Still right?"),
    ("D-4", "Invoice numbering format",
     "Two formats coexist. Which one do you want on real financial records?"),
    ("D-5", "Refund policy edges",
     "After-deadline is 75% before processing fees. Should add-ons follow the same 75% rule, "
     "or refund in full?"),
    ("D-6", "Anything in Appendix A you think should not wait",
     "List anything from the known-gaps appendix you want prioritized, and why."),
]

RESULTS = ["PASS", "FAIL", "MISSING", "UNCLEAR", "BLOCKED", "N/A"]
SEVERITIES = ["S1", "S2", "S3", "S4", "Q", "D"]
YESNO = ["Y", "N", "N/A"]

HEADERS = [
    ("Step ID", 9),
    ("Lane", 7),
    ("Step (what to do)", 56),
    ("Result", 11),
    ("Finding ID", 12),
    ("Severity", 10),
    ("What you expected", 40),
    ("What actually happened (exact error text)", 48),
    ("Timestamp (local + tz)", 21),
    ("Hard reload fix it?", 17),
    ("Device / browser", 20),
    ("Signed in as", 18),
    ("Screenshot(s)", 26),
    ("Reported in-app?", 15),
    ("Notes", 34),
]

NAVY = "1F3352"
CORAL = "F0785A"
BAND = "EEF2F7"
YELLOW = "FFF6CC"
GREY = "F4F4F4"

thin = Side(style="thin", color="C6CDD6")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


def style_header(ws, row=1, ncols=None):
    ncols = ncols or ws.max_column
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = Font(name=FONT, bold=True, color="FFFFFF", size=10)
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = 30


def build(path, person):
    wb = Workbook()

    # ------------------------------------------------------------- README
    ws = wb.active
    ws.title = "README"
    ws.sheet_view.showGridLines = False

    rows = [
        (f"UCG Platform - Stress Test Feedback ({person})", "title"),
        ("Companion to docs/plans/2026-08-19-uat-stress-test-plan.md", "sub"),
        ("", None),
        ("HOW TO USE THIS FILE", "h"),
        ("1. Go to the Findings tab. Every step from the plan is already there, in order.", "p"),
        ("2. Fill in the Result column for EVERY step - including the ones that pass.", "p"),
        ("   A PASS row takes two seconds and is what makes the untested gaps visible.", "p"),
        ("3. Only fill the rest of the row when it is NOT a plain PASS.", "p"),
        ("4. Anything BROKEN: file it in-app first (Report a problem), THEN add the row here.", "p"),
        ("   The in-app widget captures the console-error buffer, which is overwritten as you", "p"),
        ("   keep clicking. Start that description with the Finding ID and your initials.", "p"),
        ("5. Blank rows at the bottom of Findings are for anything not tied to a step.", "p"),
        ("6. Answer the Decisions tab whenever you like - no testing needed for those.", "p"),
        ("", None),
        ("WHICH CELLS YOU EDIT", "h"),
        ("Yellow-filled cells are yours. Grey cells are pre-filled from the plan - leave them.", "p"),
        ("The Lane column fills itself in from the Step ID.", "p"),
        ("", None),
        ("BEFORE YOU FILE 'IT DIDN'T UPDATE'", "h"),
        ("Hard-reload once (Ctrl+Shift+R / Cmd+Shift+R), then answer the 'Hard reload fix it?'", "p"),
        ("column. Live updates are wired for SCORES ONLY - most other cross-device changes", "p"),
        ("legitimately need a refresh. This one column saves a triage cycle every time.", "p"),
        ("", None),
        ("TEST DATA", "h"),
        ("Prefix everything you create with  ZZTEST-  so the pre-launch sweep is a search,", "p"),
        ("not an excavation. Forgot? Say so in Notes. Do NOT delete as you go - a broken row", "p"),
        ("is often the evidence.", "p"),
        ("", None),
        ("SCREENSHOTS", "h"),
        ("Filename:  <Finding ID>_<seq>_<your initials>.png     e.g.  M-07-01_01_JB.png", "p"),
        ("Include the address bar. Annotate the exact element. Use a screen RECORDING for", "p"),
        ("anything with motion. For money bugs, capture line items AND the total in one frame.", "p"),
        ("One flat folder - no subfolders; the filename already carries the structure.", "p"),
        ("", None),
        ("SEVERITY", "h"),
        ("S1  Blocker - a core flow can't complete, or money/data is wrong", "p"),
        ("S2  Major - broken or badly wrong, but there is a workaround", "p"),
        ("S3  Minor - works, but wrong in a way a user would notice", "p"),
        ("S4  Polish - cosmetic", "p"),
        ("Q   Question - you can't tell whether it's wrong", "p"),
        ("D   Decision needed - works as built, but is it what we want?  <- most valuable", "p"),
        ("", None),
        ("RESULT CODES", "h"),
        ("PASS / FAIL / MISSING (described behavior doesn't exist) / UNCLEAR (couldn't tell) /", "p"),
        ("BLOCKED (couldn't get to it) / N/A (doesn't apply to you)", "p"),
        ("", None),
        ("PROGRESS", "h"),
    ]
    r = 1
    for text, kind in rows:
        c = ws.cell(row=r, column=1, value=text)
        if kind == "title":
            c.font = Font(name=FONT, bold=True, size=16, color=NAVY)
            ws.row_dimensions[r].height = 22
        elif kind == "sub":
            c.font = Font(name=FONT, size=10, italic=True, color="5A6875")
        elif kind == "h":
            c.font = Font(name=FONT, bold=True, size=11, color=NAVY)
        else:
            c.font = Font(name=FONT, size=10)
        r += 1

    prog_start = r
    # Ranges start at row 3 so the example row (row 2) never counts.
    # "?-??" matches a step id (A-01) but not a lane banner or an extra
    # finding id (M-X-01), so the denominator stays the real step count.
    counters = [
        ("Steps in the plan", '=COUNTIF(Findings!A3:A2000,"?-??")'),
        ("Steps with a Result filled in", '=COUNTIFS(Findings!A3:A2000,"?-??",Findings!D3:D2000,"<>")'),
        ("Still to do", '=COUNTIF(Findings!A3:A2000,"?-??")-COUNTIFS(Findings!A3:A2000,"?-??",Findings!D3:D2000,"<>")'),
        ("", None),
        ("PASS", '=COUNTIF(Findings!D3:D2000,"PASS")'),
        ("FAIL", '=COUNTIF(Findings!D3:D2000,"FAIL")'),
        ("MISSING", '=COUNTIF(Findings!D3:D2000,"MISSING")'),
        ("UNCLEAR", '=COUNTIF(Findings!D3:D2000,"UNCLEAR")'),
        ("BLOCKED", '=COUNTIF(Findings!D3:D2000,"BLOCKED")'),
        ("", None),
        ("S1 blockers", '=COUNTIF(Findings!F3:F2000,"S1")'),
        ("S2 major", '=COUNTIF(Findings!F3:F2000,"S2")'),
        ("Decisions raised (D)", '=COUNTIF(Findings!F3:F2000,"D")'),
    ]
    for label, formula in counters:
        if formula is None:
            r += 1
            continue
        ws.cell(row=r, column=1, value=label).font = Font(name=FONT, size=10)
        cell = ws.cell(row=r, column=2, value=formula)
        cell.font = Font(name=FONT, size=10, bold=True, color=NAVY)
        cell.alignment = Alignment(horizontal="left")
        r += 1
    ws.cell(row=prog_start - 1, column=1).font = Font(name=FONT, bold=True, size=11, color=NAVY)

    ws.column_dimensions["A"].width = 92
    ws.column_dimensions["B"].width = 12

    # ------------------------------------------------------------ Findings
    fs = wb.create_sheet("Findings")
    for i, (title, width) in enumerate(HEADERS, start=1):
        fs.cell(row=1, column=i, value=title)
        fs.column_dimensions[get_column_letter(i)].width = width
    style_header(fs, 1, len(HEADERS))
    fs.freeze_panes = "D2"

    # Example row (row 2), clearly marked so it isn't mistaken for real data.
    example = [
        "M-07", None,
        "EXAMPLE ROW - delete or overwrite me",
        "FAIL", "M-07-01", "S1",
        "3-D Secure challenge appears, then the payment completes",
        'Challenge appeared, I approved it, then "Something went wrong" and the cart still had the item',
        "2026-08-19 14:32 PT", "N", "Win 11 / Chrome 141", "Athlete (ZZTEST-Robin)",
        "M-07-01_01_JB.png, M-07-01_02_JB.png", "Y",
        "Reproduced twice. Stripe dashboard shows no payment attempt at all.",
    ]
    for i, val in enumerate(example, start=1):
        c = fs.cell(row=2, column=i, value=val)
        c.font = Font(name=FONT, size=10, italic=True, color="8A7A2E")
        c.fill = PatternFill("solid", fgColor=YELLOW)
        c.alignment = Alignment(vertical="top", wrap_text=True)
        c.border = BORDER
    fs.cell(row=2, column=2, value='=IFERROR(LEFT(A2,FIND("-",A2)-1),"")')
    fs.row_dimensions[2].height = 42

    # Lane banner + step rows
    row = 3
    lane_rows = []
    for letter, lane_name, steps in LANES:
        fs.cell(row=row, column=1, value=f"{letter}  -  {lane_name}")
        fs.merge_cells(start_row=row, start_column=1, end_row=row, end_column=len(HEADERS))
        b = fs.cell(row=row, column=1)
        b.font = Font(name=FONT, bold=True, size=11, color="FFFFFF")
        b.fill = PatternFill("solid", fgColor=CORAL)
        b.alignment = Alignment(vertical="center", indent=1)
        fs.row_dimensions[row].height = 20
        lane_rows.append(row)
        row += 1
        for n, label in enumerate(steps, start=1):
            step_id = f"{letter}-{n:02d}"
            fs.cell(row=row, column=1, value=step_id)
            fs.cell(row=row, column=2,
                    value=f'=IFERROR(LEFT(A{row},FIND("-",A{row})-1),"")')
            fs.cell(row=row, column=3, value=label)
            for col in (1, 2, 3):
                c = fs.cell(row=row, column=col)
                c.font = Font(name=FONT, size=10,
                              bold=col == 1,
                              color=NAVY if col == 1 else "222222")
                c.fill = PatternFill("solid", fgColor=GREY)
                c.alignment = Alignment(vertical="top", wrap_text=col == 3)
                c.border = BORDER
            for col in range(4, len(HEADERS) + 1):
                c = fs.cell(row=row, column=col)
                c.font = Font(name=FONT, size=10)
                c.fill = PatternFill("solid", fgColor=YELLOW if col in (4,) else "FFFFFF")
                c.alignment = Alignment(vertical="top", wrap_text=col in (7, 8, 15))
                c.border = BORDER
            fs.row_dimensions[row].height = 15
            row += 1

    last_step_row = row - 1

    # Overflow rows for findings not tied to a step
    fs.cell(row=row, column=1, value="EXTRA  -  findings not tied to a step (use e.g. M-X-01)")
    fs.merge_cells(start_row=row, start_column=1, end_row=row, end_column=len(HEADERS))
    b = fs.cell(row=row, column=1)
    b.font = Font(name=FONT, bold=True, size=11, color="FFFFFF")
    b.fill = PatternFill("solid", fgColor=NAVY)
    b.alignment = Alignment(vertical="center", indent=1)
    row += 1
    extra_start = row
    for _ in range(60):
        fs.cell(row=row, column=2,
                value=f'=IFERROR(LEFT(A{row},FIND("-",A{row})-1),"")')
        for col in range(1, len(HEADERS) + 1):
            c = fs.cell(row=row, column=col)
            c.font = Font(name=FONT, size=10)
            c.fill = PatternFill("solid", fgColor=YELLOW if col in (1, 4) else "FFFFFF")
            c.alignment = Alignment(vertical="top", wrap_text=col in (3, 7, 8, 15))
            c.border = BORDER
        row += 1
    last_row = row - 1

    # Dropdowns
    dv_result = DataValidation(type="list", formula1=f'"{",".join(RESULTS)}"', allow_blank=True)
    dv_sev = DataValidation(type="list", formula1=f'"{",".join(SEVERITIES)}"', allow_blank=True)
    dv_yn = DataValidation(type="list", formula1=f'"{",".join(YESNO)}"', allow_blank=True)
    dv_inapp = DataValidation(type="list", formula1='"Y,N"', allow_blank=True)
    for dv in (dv_result, dv_sev, dv_yn, dv_inapp):
        fs.add_data_validation(dv)
    dv_result.add(f"D2:D{last_row}")
    dv_sev.add(f"F2:F{last_row}")
    dv_yn.add(f"J2:J{last_row}")
    dv_inapp.add(f"N2:N{last_row}")

    fs.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{last_row}"

    # ----------------------------------------------------------- Decisions
    ds = wb.create_sheet("Decisions")
    ds.sheet_view.showGridLines = False
    ds.cell(row=1, column=1, value="Decisions needed - no testing required, just your answer")
    ds.cell(row=1, column=1).font = Font(name=FONT, bold=True, size=14, color=NAVY)
    ds.merge_cells("A1:D1")
    dhead = ["#", "Topic", "The question", "Your answer"]
    for i, h in enumerate(dhead, start=1):
        ds.cell(row=3, column=i, value=h)
    style_header(ds, 3, len(dhead))
    for i, (num, topic, q) in enumerate(DECISIONS, start=4):
        ds.cell(row=i, column=1, value=num).font = Font(name=FONT, bold=True, size=10, color=NAVY)
        ds.cell(row=i, column=2, value=topic).font = Font(name=FONT, size=10, bold=True)
        ds.cell(row=i, column=3, value=q).font = Font(name=FONT, size=10)
        ans = ds.cell(row=i, column=4)
        ans.fill = PatternFill("solid", fgColor=YELLOW)
        ans.font = Font(name=FONT, size=10)
        for col in range(1, 5):
            cc = ds.cell(row=i, column=col)
            cc.alignment = Alignment(vertical="top", wrap_text=True)
            cc.border = BORDER
        ds.row_dimensions[i].height = 58
    for col, w in zip("ABCD", (6, 30, 66, 52)):
        ds.column_dimensions[col].width = w

    wb.save(path)
    return last_step_row, extra_start, last_row


if __name__ == "__main__":
    out_dir = sys.argv[1]
    for who, fname in (("Nate", "feedback-nate.xlsx"), ("Julia", "feedback-julia.xlsx")):
        info = build(f"{out_dir}/{fname}", who)
        print(fname, "steps end row:", info[0], "extra rows:", info[1], "-", info[2])
