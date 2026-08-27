/**
 * Minimal RFC-4180-style delimited-text parser. Handles quoted fields,
 * escaped quotes ("") inside them, and commas or tabs as delimiters — the
 * naive split-on-comma parsers corrupted any Excel/Sheets export whose cells
 * contained commas.
 */
export function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  const src = text.replace(/^﻿/, ""); // strip BOM
  // Detect delimiter from the first line: prefer tab when present.
  const firstLine = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
  const delim = firstLine.includes("\t") ? "\t" : ",";

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field.trim());
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field.trim());
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** Parse delimited text with a header row into keyed records. */
export function parseDelimitedRecords(text: string): Record<string, string>[] {
  const rows = parseDelimited(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = cells[i] ?? ""));
    return rec;
  });
}
