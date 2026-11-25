// Table extraction for the official BGS debarment page.
//
// extractDebarmentTable runs INSIDE the browser via page.evaluate(), so it
// must be fully self-contained: no imports, no closures over module scope.
//
// Identification rule (see docs/DESIGN-AND-FEASIBILITY.md §2):
//   exactly one <table> whose first row is exactly two cells reading
//   "Name" and "Expiration Term" (after whitespace/&nbsp; normalization).
//   Zero or several matches => failure; we never guess.
// Text normalization: trim surrounding whitespace and collapse internal
// whitespace runs (including &nbsp;) to one space. Nothing else is changed:
// no filtering, no deduplication, no date parsing, official order kept.

export function extractDebarmentTable(doc) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim(); // \s includes U+00A0 (&nbsp;)
  const isHeader = (row) =>
    row &&
    row.cells.length === 2 &&
    norm(row.cells[0].textContent) === 'Name' &&
    norm(row.cells[1].textContent) === 'Expiration Term';

  const matches = [...doc.querySelectorAll('table')].filter((t) => isHeader(t.rows[0]));
  if (matches.length === 0) return { ok: false, reason: 'No table with header "Name | Expiration Term" found.' };
  if (matches.length > 1) return { ok: false, reason: `Found ${matches.length} tables with the debarment header; refusing to guess.` };

  const table = matches[0];
  const warnings = [];
  const wrapped = !!(table.parentElement && table.parentElement.classList.contains('usa-table-container--tyler-scrollable'));
  if (!wrapped) warnings.push('Table is not inside the usa-table-container--tyler-scrollable wrapper (site script may not have run).');

  const records = [];
  const rows = [...table.rows].slice(1);
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells;
    if (cells.length !== 2) {
      return { ok: false, reason: `Data row ${i + 1} has ${cells.length} cells; expected 2.` };
    }
    const name = norm(cells[0].textContent);
    const expiration_term = norm(cells[1].textContent);
    if (name === '' && expiration_term === '') {
      warnings.push(`Data row ${i + 1} is blank in both columns; kept as listed.`);
    } else if (!/^\d{2}\/\d{2}\/\d{4}$/.test(expiration_term)) {
      warnings.push(`Data row ${i + 1} expiration term "${expiration_term}" is not MM/DD/YYYY; published verbatim.`);
    }
    records.push({ name, expiration_term });
  }
  return { ok: true, records, wrapped, warnings };
}
