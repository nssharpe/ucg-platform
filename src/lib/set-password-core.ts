// Pure decision logic for the /set-password landing flow — split out for the
// same reason mfa-core.ts is split from mfa.ts: no React/Supabase imports, so
// it's directly unit-testable.

export type SetPwMarker = 'invite' | 'reset' | 'legacy' | null;

/** Resolve which flavor of the set-password flow this page load is, combining
 *  the `?setpw=...` marker (auth.ts's `initialSetPwKind`) with whether a
 *  PASSWORD_RECOVERY auth event was observed (`hasSeenPasswordRecoveryEvent`,
 *  auth.ts) — used to fill in 'reset' when the marker didn't survive the
 *  redirect (UAT round 2 A-06-02: Supabase's redirect allow-list was silently
 *  stripping query strings from `redirectTo`, so the marker could be entirely
 *  ABSENT even on a genuine reset link — the allow-list has since been fixed,
 *  but the client should not depend on that staying true).
 *
 *  Precedence — an explicit marker ALWAYS wins over the event, in either
 *  direction:
 *  1. Marker `'invite'`/`'legacy'` → `'invite'`.
 *  2. Marker `'reset'` → `'reset'`.
 *  3. No marker at all → the PASSWORD_RECOVERY event decides: seeing it
 *     confirms `'reset'`; not seeing it either still defaults to the safer
 *     `'reset'` flavor (landing Home is a much smaller surprise than landing
 *     on Membership when the flow's actual origin can't be determined at
 *     all — this also fixes the pre-round-2 default, which was
 *     'invite'/membership and is what confused Julia when the marker was
 *     silently dropped).
 *
 *  The event must NEVER override an explicit marker (a first draft of this
 *  function did exactly that and broke a real path): `invite-account`
 *  (the edge function behind AdminMembers' "Invite"/"Resend" and Club.tsx's
 *  "add athlete") falls back to a Supabase RECOVERY-type link — still marked
 *  `?setpw=invite` — for any invitee whose auth user already exists (its
 *  `invite` link generation 422s, so it retries as `recovery`). Consuming
 *  that link fires a genuine PASSWORD_RECOVERY event even though the marker,
 *  and the invite email's copy, both say 'invite'. Overriding the marker
 *  there would silently send that person Home after an email that told them
 *  they'd land on Membership. */
export function resolveSetPasswordFlavor(marker: SetPwMarker, sawPasswordRecoveryEvent: boolean): 'invite' | 'reset' {
  if (marker === 'invite' || marker === 'legacy') return 'invite';
  if (marker === 'reset') return 'reset';
  // No marker survived — fall back to the event. Both branches currently
  // resolve to 'reset' (there is no third flavor to fall back to today), but
  // written explicitly so the precedence stays correct if that ever changes.
  if (sawPasswordRecoveryEvent) return 'reset';
  return 'reset';
}
