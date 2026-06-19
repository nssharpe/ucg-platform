# SMS / Texting Provider Research (2026-06-18)

Goal: pick a provider for bulk SMS from the **Communicate** tool (UCG sometimes
sends ~2,000 texts at once) and enforce per-message character limits in the UI.

> Per-message rates change; figures below were pulled 2026-06-18 from provider
> pricing pages (sources at bottom). Treat them as estimates — confirm at sign-up.

## TL;DR recommendation
- **Telnyx** for lowest per-message cost (~$0.004/SMS segment) if you're
  comfortable with a slightly more developer-oriented console.
- **Twilio** if you want the most documentation, easiest integration, and
  broadest support — pay ~2× per message for it.
- Either way you **must register for A2P 10DLC** (US application-to-person) before
  sending. Budget ~1–3 weeks for brand + campaign approval. A **non-profit / lower
  volume** registration tier exists and is cheap.
- Enforce the **160-character GSM-7 limit** (70 for Unicode) in the Communicate
  composer and show a live segment counter, because every segment is billed.

## Cost comparison (US, A2P 10DLC long code)

| Item | Twilio | Telnyx | AWS SNS |
|---|---|---|---|
| Per SMS segment (outbound) | ~$0.0079 + carrier fees | ~$0.004 | ~$0.00581 + carrier fees |
| Carrier pass-through fee / segment | ~$0.003 (AT&T/T-Mo/Verizon vary) | included/low | varies |
| Long-code number | ~$1.15/mo | ~$1/mo | n/a (uses pool) |
| Toll-free number | ~$2.15/mo | ~$1–2/mo | n/a |
| 10DLC brand registration | $4.50 one-time (sole prop / low-volume) | $4.50 one-time | via provider |
| 10DLC standard brand (w/ vetting) | ~$46 one-time | varies | — |
| 10DLC campaign fee | ~$10/mo (standard use case) | ~$10/mo | — |

**What a 2,000-message blast costs** (one 160-char segment each, all-in incl.
carrier fees):
- Twilio: ~$0.011/msg all-in → **~$22 per blast**.
- Telnyx: ~$0.004–0.005/msg → **~$8–10 per blast**.
- AWS SNS: ~$0.006–0.009/msg → **~$12–18 per blast**.
Monthly fixed cost on top: ~$10 campaign + ~$1–2 number = ~$12/mo regardless.

## Throughput for big blasts (the 2,000-at-once concern)
- A2P 10DLC throughput is governed by your **campaign's trust score → messages
  per second (MPS)** and daily caps. A standard-vetted campaign typically gets
  much higher MPS than an unvetted one.
- A single standard long code commonly sends on the order of **tens of MPS** after
  vetting; 2,000 messages then drains in a couple of minutes. Unvetted/low tiers
  can be a few MPS (2,000 msgs ≈ 10–30 min) and may hit **daily caps** (e.g.
  2,000–10,000/day depending on tier).
- **Toll-free** A2P (separately verified) can offer high throughput and is a good
  alternative for one-to-many broadcasts; it also needs verification.
- For reliable 2,000-at-once sends: get a **standard-vetted 10DLC campaign** (or a
  verified toll-free number), and let the provider queue/drip — both Twilio and
  Telnyx accept the whole batch and meter it out at your allowed MPS.

## Character limits — enforce these in Communicate
SMS encodes one of two ways; the composer should detect which and count segments:

| Encoding | When used | Single-segment limit | Per-segment in a multi-part message |
|---|---|---|---|
| **GSM-7** | plain text (Latin, basic punctuation) | **160 chars** | **153 chars** |
| **UCS-2 / Unicode** | any emoji or non-GSM char (e.g. curly quotes, é, —) | **70 chars** | **67 chars** |

Implications for the UI:
- Show a **live counter**: characters used, encoding detected, and **# of segments**
  (each segment is billed separately).
- Warn when a message crosses into a new segment, and **hard-warn on Unicode**
  (a single emoji drops the limit from 160 → 70 and can 2–3× the cost of a blast).
- Watch for "smart quotes"/em-dashes from copy-paste — they silently force UCS-2.
  Consider an optional "normalize to GSM-7" button (replace — → -, " " → ").
- A practical default cap: **one segment** (160 GSM-7 / 70 Unicode) for routine
  blasts, with an explicit "send as N segments" confirmation to spend more.

## Compliance notes (don't skip)
- **A2P 10DLC registration is mandatory** for US business texting; unregistered
  traffic is heavily filtered/blocked by carriers.
- Include **opt-out handling** (STOP/HELP) — providers handle STOP automatically,
  but your brand/campaign must declare it and your audience must have opted in.
- Keep a consent record per recipient (when/how they opted into texts). The
  member profile already stores `phone`; add an SMS-consent flag when this is wired.

## Suggested integration shape (when built)
- A **Supabase Edge Function** `send-sms` that takes a recipient list + body, splits
  into provider-batched calls, and returns per-recipient status — same place the
  Stripe + transactional-email functions will live (see the Stripe plan).
- Store a **send log** (recipients, segment count, cost estimate, timestamps) so the
  Communicate tool's "confirmation of who it went to" (already stubbed in the UI)
  becomes real.
- Enforce the character/segment limit **client-side** (live counter) AND
  **server-side** (reject/alert over a configured max).

## Sources
- [Twilio US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us)
- [Twilio A2P 10DLC fees](https://help.twilio.com/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service-)
- [Twilio A2P 10DLC docs](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)
- [Telnyx messaging pricing](https://telnyx.com/pricing/messaging)
- [Twilio SMS cost breakdown 2026 (apidog)](https://apidog.com/blog/twilio-sms-api-cost/)
- [Telnyx 10DLC vs toll-free](https://telnyx.com/resources/10dlc-vs-toll-free-isvs)
