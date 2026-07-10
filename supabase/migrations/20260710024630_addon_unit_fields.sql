-- Per-unit add-on lines (event-mgmt v2 Phase 2, Task 1): each banquet ticket /
-- t-shirt / leo unit purchased is now its own cart/invoice line (refund-ready),
-- rather than one line per add-on type. `addon_size` carries the shirt/leo size
-- for that unit; `addon_assignee` carries who a banquet ticket is for — a
-- person id, or the literal sentinel 'extra' for an unassigned ticket. Both are
-- nullable and unused by other line kinds. Enforcement of "at most one assigned
-- banquet ticket per person per event" is server-side (Task 2), not here.
alter table cart_items add column if not exists addon_size text, add column if not exists addon_assignee text;
alter table invoice_items add column if not exists addon_size text, add column if not exists addon_assignee text;
