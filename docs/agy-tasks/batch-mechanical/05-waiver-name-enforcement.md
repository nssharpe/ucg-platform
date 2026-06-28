# Waiver name enforcement on the over-18 direct-link path

## Context
When an athlete who is 18+ signs their own waiver via a direct signing link, the flow
must verify the typed name matches the athlete — the SAME name-match validation already
enforced during the inline membership-purchase signing flow. Today the direct-link path
does not enforce it. (Area: the waiver signing components — the direct-link signing page
vs. the inline purchase signing; reuse the inline path's validation.)

## Requirements
1. On the over-18 direct-link waiver signing, require the signer's typed name to match
   the athlete's name before the signature can be submitted, identical to the inline
   membership purchase workflow's check.
2. Reuse the existing name-match validation logic from the inline flow rather than
   writing a parallel one, so the two paths stay consistent.

## Constraints
- Do not change waiver storage / PDF generation. Follow `.agents/AGENTS.md`.

## Definition of done
- The direct-link path rejects a mismatched name and accepts a matching one, matching the
  inline flow. Build / eslint(touched) / vitest clean. If the name-match is a pure helper,
  add/extend a vitest test. Report files changed.
