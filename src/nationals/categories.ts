import type { Category } from './types';

/**
 * Derive placement category from (student, gender), mirroring the reference
 * tool's `discipline.calculate_placement_category`:
 *   Student  → Collegiate, else Community
 *   Gender F → Women+,     else (M / O / anything) → Men+
 *
 * NOTE: the platform's `Gender` enum is richer (Non-binary, Agender, …). The
 * reference only branches on `== 'F'`, so every non-Female value maps to Men+.
 * Flagged to rules@naigc.org — confirm before changing.
 */
export function deriveCategory(gender: string, student: boolean): Category {
  const women = gender === 'F' || gender === 'Female';
  if (student) return women ? 'Collegiate Women+' : 'Collegiate Men+';
  return women ? 'Community Women+' : 'Community Men+';
}
