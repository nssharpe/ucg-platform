-- Athlete self-serve WITHDRAWAL (product owners' spec 2026-08-23).
--
-- `withdrawn_at` distinguishes a registration kept-but-blanked because the
-- athlete withdrew AFTER the event's `last_date_to_edit` from an ordinary
-- blanked row (e.g. a fully-deselected discipline in the member editor, or a
-- post-deadline REFUND approval, which uses `refunded: true` instead —
-- money-invariants.md). A late withdrawal moves no money, so it must never
-- be recorded as `refunded: true`; this column is what lets rosters/results
-- tell "withdrew late" apart from either of those without overloading
-- `refunded`.
--
-- Written ONLY by the `withdraw-registration` edge function via a targeted
-- column UPDATE (service role) — deliberately NOT part of the client's
-- whole-row `registrationToRow` upsert mapping, so an ordinary registration
-- edit/save can never silently clear it back to null.
alter table public.registrations add column if not exists withdrawn_at timestamptz;

comment on column public.registrations.withdrawn_at is
  'Set when the athlete self-withdrew after the event''s last_date_to_edit (kept-but-blanked, apparatus scratched, refunded stays false — no money moved). NULL otherwise.';
