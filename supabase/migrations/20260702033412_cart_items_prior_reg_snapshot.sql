-- Task A (unified-cart-b2): let a "change" cart item carry a snapshot of the
-- registration(s) it modified, so deleting the cart item can revert them
-- instead of leaving a mutated/orphaned registration behind.
alter table cart_items add column if not exists prior_reg_snapshot jsonb;

comment on column cart_items.prior_reg_snapshot is
  'Nullable JSON array of the affected registration row(s)'' full pre-change field values, captured when a kind=meet-entry/ref_line_type=change cart item is created. Null for non-change items and for rows created before this feature existed. Used to revert the registration(s) if the cart item is deleted before payment.';
