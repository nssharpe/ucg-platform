-- Add the newer calculator provenance values to score_source
-- (wag-sv and T&T calculators landed after 0001 was written).
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block —
-- run each statement on its own in the SQL editor.
alter type score_source add value if not exists 'wag-sv-calc';
alter type score_source add value if not exists 'tnt-calc';
