-- 3f: explicit "entry fee paid" flag on registrations.
-- New registrations default to FALSE ("Pending Purchase") until their entry/
-- change fee is paid through the existing pay paths, which flip it to TRUE.
alter table registrations
  add column paid boolean not null default false;

-- Distinguishes a never-paid "Pending Purchase" from an already-paid
-- registration that was edited into a re-pending state by a change fee
-- ("Updated pending purchase"). Set true alongside paid=false on a chargeable
-- edit; cleared when the change fee is paid.
alter table registrations
  add column updated_pending boolean not null default false;

-- Backfill: rows that predate this feature were created under the old
-- "register = done" model (no payment state existed), so treat them as paid to
-- avoid mislabeling historical registrations as pending. Safe one-time update.
update registrations set paid = true;

-- RLS unchanged: the column is covered by the existing registrations policies.

-- Link a meet-entry / change-fee cart & invoice line back to the exact
-- registration id(s) it pays for, so the pay path flips precisely those rows to
-- paid (3f). text[] of registration uuids (kept as text to mirror how the app
-- serializes ids; no FK so a refunded/deleted reg never blocks cart cleanup).
alter table cart_items    add column ref_reg_ids text[];
alter table invoice_items add column ref_reg_ids text[];
