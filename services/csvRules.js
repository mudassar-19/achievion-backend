// CSV for Excel (D-277) — pure. Every cell is quoted; a cell that would run as a formula (= + - @, or a leading tab / CR) gets a
// leading ' (OWASP "CSV injection"); plain numbers like -10 or 12.5% stay numbers. Send the file with CSV_BOM and
// "text/csv; charset=utf-8" so Excel reads names such as "Zoë" correctly.
export const CSV_BOM = "﻿";
const NUMBER = /^[+-]?\d+(\.\d+)?( XP|%)?$/;
export const csvCell = (v) => {
  const s = String(v ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) && !NUMBER.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
export const toCsv = (headers, rows) => [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
