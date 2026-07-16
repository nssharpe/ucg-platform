// Shared exceljs wiring for building + downloading a multi-sheet workbook
// from plain SheetModel data (event-mgmt v2 Phase 6 T3). Extracted from
// src/pages/Events.tsx's HostExportCard (registration workbook export,
// Phase 2 T7) so the finance dashboard (Finance.tsx) can reuse the exact
// same download behavior instead of re-wiring exceljs. exceljs is
// dynamically imported so it stays out of the main bundle — same reasoning
// as before the extraction.
import type { SheetModel } from './host-export';

export type { SheetModel };

/** Thin exceljs wiring for one sheet model: header row (bold, frozen), column
 *  widths sized to content, and the data rows as-is. Kept intentionally
 *  untested — the shaping logic that produces each SheetModel lives
 *  elsewhere (host-export.ts, finance.ts) and IS unit-tested. */
function writeSheet(wb: import('exceljs').Workbook, sheet: SheetModel): void {
  const ws = wb.addWorksheet(sheet.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = sheet.columns.map((header, i) => ({
    header,
    width: Math.min(40, Math.max(10, header.length + 2, ...sheet.rows.map((r) => String(r[i] ?? '').length + 2))),
  }));
  ws.getRow(1).font = { bold: true };
  for (const row of sheet.rows) ws.addRow(row);
}

/** Builds a workbook from `sheets` and triggers a browser download as
 *  `filename` (should already include the .xlsx extension). */
export async function downloadWorkbook(sheets: SheetModel[], filename: string): Promise<void> {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  wb.creator = 'UCG Registration Platform';
  wb.created = new Date();
  for (const sheet of sheets) writeSheet(wb, sheet);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
