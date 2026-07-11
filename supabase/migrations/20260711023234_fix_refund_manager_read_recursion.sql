-- HOTFIX for 20260710230000_refund_manager_review_reads: infinite RLS
-- recursion (SQLSTATE 42P17) that broke EVERY invoice_items read the moment
-- it was applied (surfaced by the e2e suite against staging; prod had the
-- same breakage for the minutes until this hotfix).
--
-- The cycle: the pre-existing `invoice_items_read` policy (20260601000004)
-- checks the PARENT invoice (`exists (select 1 from invoices ...)`), and the
-- new `invoices_refund_manager_read` policy checked the CHILD items
-- (`exists (select 1 from invoice_items ...)`). Policy subqueries run with
-- the caller's own privileges, so evaluating either table's policies forces
-- evaluating the other's -- Postgres detects the cycle and errors 42P17 for
-- ALL callers (the role predicate doesn't short-circuit the plan).
--
-- Fix: replace the raw subqueries with SECURITY DEFINER helper functions.
-- Their bodies run as the function owner and BYPASS RLS, so no policy
-- re-entry -- the same reason my_person_id()/manages_club() are safe to use
-- inside policies. Scope/semantics of the grants are unchanged from the
-- original migration's intent. Fail-closed: revoke PUBLIC execute (CLAUDE.md
-- rule for new functions); policies still AND with the refund_manager role.

drop policy if exists invoice_items_refund_manager_read on invoice_items;
drop policy if exists invoices_refund_manager_read on invoices;

-- Does any refund request reference this invoice_item? (RLS-bypassing)
create or replace function refund_request_covers_item(iid text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from refund_requests rr where rr.invoice_item_id = iid);
$$;
revoke execute on function refund_request_covers_item(text) from public;
grant execute on function refund_request_covers_item(text) to authenticated;

-- Does any refund request reference a line of this invoice? (RLS-bypassing)
create or replace function refund_request_covers_invoice(inv text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from invoice_items ii
    join refund_requests rr on rr.invoice_item_id = ii.id
    where ii.invoice_id = inv
  );
$$;
revoke execute on function refund_request_covers_invoice(text) from public;
grant execute on function refund_request_covers_invoice(text) to authenticated;

create policy invoice_items_refund_manager_read on invoice_items for select
  using (
    coalesce(auth_has_role('refund_manager'), false)
    and refund_request_covers_item(invoice_items.id)
  );

create policy invoices_refund_manager_read on invoices for select
  using (
    coalesce(auth_has_role('refund_manager'), false)
    and refund_request_covers_invoice(invoices.id)
  );

-- The people_refund_manager_read policy from the same migration is NOT
-- cyclic (people -> refund_requests/registrations; neither table's policies
-- reference people except via SECURITY DEFINER my_person_id()) and stays.
