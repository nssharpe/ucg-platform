// Pure decision logic for PersonForm's "Send account invite now" checkbox
// (UAT A-07-01 Nate) — no React/Supabase imports, directly unit-testable.

export interface ShouldSendInviteOnCreateInput {
  /** True only for the "+ New Person" (create) flow — never on an edit. */
  isNew: boolean;
  email: string;
  /** The checkbox's checked state. */
  checked: boolean;
}

/** Whether creating a person should also fire an account-setup invite.
 *  Requires: it's a creation (not an edit), the checkbox is checked, and an
 *  email address is present (the checkbox is disabled without one in the UI,
 *  but this stays defensive so the caller doesn't have to trust that). */
export function shouldSendInviteOnCreate({ isNew, email, checked }: ShouldSendInviteOnCreateInput): boolean {
  return isNew && checked && email.trim().length > 0;
}
