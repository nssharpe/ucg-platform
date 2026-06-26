-- Stripe S4: robust line-tag columns for server-side re-pricing.
-- ref_meet_id   = the meet a meet-entry / addon line belongs to (addon lines carry no reg ids,
--                 so this is required to price them; also set on meet-entry lines).
-- ref_line_type = refines `kind` for recompute: 'entry'|'change' for meet-entry lines,
--                 'tshirt'|'banner' for addon lines. Null for membership lines.
alter table cart_items     add column if not exists ref_meet_id   text;
alter table cart_items     add column if not exists ref_line_type text;
alter table invoice_items  add column if not exists ref_meet_id   text;
alter table invoice_items  add column if not exists ref_line_type text;
