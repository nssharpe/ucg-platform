// The UCG-YYYY-NNNN invoice-number format contract, mirrored server-side by
// the `next_invoice_number` SQL function (migration `20260821140000`):
//   'UCG-' || year || '-' || lpad(seq::text, 4, '0')
// This helper documents that contract for the client/tests — it isn't called
// by the numbering path itself (numbers are minted exclusively by the
// server-side RPC, never formatted client-side — see
// `src/lib/supabase.ts` `nextInvoiceNumber` and
// `supabase/functions/_shared/fulfill.ts`), but keeping the two in lockstep
// as plain, independently testable logic is cheaper than re-deriving the
// format by reading SQL whenever it needs checking.
export function formatInvoiceNumber(year: number, seq: number): string {
  // lpad does not truncate — a seq > 9999 naturally widens past 4 digits
  // rather than corrupting the number (same behavior as the SQL side).
  return `UCG-${year}-${String(seq).padStart(4, '0')}`;
}
