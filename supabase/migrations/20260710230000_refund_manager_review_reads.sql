-- Event-management v2 Phase 3, Task 6: the refund review queue (T6, spec §H)
-- needs to display item labels/amounts and requester/athlete names. The
-- `refund_manager` role already gets full read on `refund_requests` itself
-- (`refund_requests_select_reviewers`, T4), but is NOT implicitly an admin
-- elsewhere (CLAUDE.md) and has none of the existing invoice/people read
-- branches (`is_admin()` / `athlete_id = my_person_id()` / `manages_club(...)`)
-- for an arbitrary member's purchase. Additive SELECT-only policies, scoped to
-- rows a refund manager could already see referenced by a `refund_requests`
-- row (not a blanket league-wide grant) -- writes stay exclusively via the
-- service-role `process-refund` Edge Function (T6).
--
-- Admins already read all of these tables via existing is_admin() branches;
-- this migration only adds the refund_manager-role branch.

-- invoice_items: exactly the line stamped on a refund_requests row (both
-- kinds stamp invoice_item_id -- see request-refund's registration-kind fix,
-- commit 42f5776).
create policy invoice_items_refund_manager_read on invoice_items for select
  using (
    coalesce(auth_has_role('refund_manager'), false)
    and exists (select 1 from refund_requests rr where rr.invoice_item_id = invoice_items.id)
  );

-- invoices: the PARENT of a visible invoice_item, above -- needed because the
-- client-side sync (src/lib/supabase.ts syncFromSupabase) only attaches an
-- invoice_item onto `db.invoices` when the invoice row itself is also
-- RLS-visible; without this, invoice_items_refund_manager_read alone would
-- fetch the raw row but the app would never surface it (no orphaned-item path
-- in `itemsByInvoice`/`invoices` stitching).
create policy invoices_refund_manager_read on invoices for select
  using (
    coalesce(auth_has_role('refund_manager'), false)
    and exists (
      select 1 from invoice_items ii
      join refund_requests rr on rr.invoice_item_id = ii.id
      where ii.invoice_id = invoices.id
    )
  );

-- people: the requester who filed the request, or the athlete on the
-- referenced registration (kind='registration').
create policy people_refund_manager_read on people for select
  using (
    coalesce(auth_has_role('refund_manager'), false)
    and (
      exists (select 1 from refund_requests rr where rr.requester_person_id = people.id)
      or exists (
        select 1 from refund_requests rr
        join registrations r on r.id = rr.reg_id
        where r.athlete_id = people.id
      )
    )
  );
