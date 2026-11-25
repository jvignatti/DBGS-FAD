// Extraction tests run the production function inside real Chromium against
// fixtures. All network is blocked: fixtures are never fetched live and
// never published.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { extractDebarmentTable } from '../scripts/extract.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const REAL = fx('bgs-2026-11-25.html');
const TABLE_RE = /<table[\s\S]*?<\/table>/;
const withTable = (tableHtml) => REAL.replace(TABLE_RE, tableHtml);
const hdr = '<tr><td>Name</td><td style="width: 449px;">Expiration Term&nbsp;</td></tr>';

let browser, page;
before(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**/*', (r) => r.abort());
  page = await ctx.newPage();
});
after(async () => browser?.close());

async function run(html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return page.evaluate(`(${extractDebarmentTable.toString()})(document)`);
}

test('real 2026-11-25 page: 9 records, official text and order', async () => {
  const r = await run(REAL);
  assert.equal(r.ok, true);
  assert.deepEqual(r.records, [
    { name: 'Two Sisters Mill & Mercantile LLC', expiration_term: '12/26/2026' },
    { name: "Delair's Carpet Barn", expiration_term: '03/31/2027' },
    { name: 'MadFreedom Advocates, Inc.', expiration_term: '07/08/2031' },
    { name: 'Battenkill Communications, Inc', expiration_term: '07/10/2027' },
    { name: 'Music Contact International', expiration_term: '07/05/2027' },
    { name: 'AJT Enterprises, Inc.', expiration_term: '07/18/2027' },
    { name: 'Valley Floor’s, Inc.', expiration_term: '10/16/2028' },
    { name: 'Michael Miller DBA La Strada Bakery', expiration_term: '10/15/2027' },
    { name: 'A W T, Inc. dba Little A Wood Floors', expiration_term: '11/13/2027' },
  ]);
  // Site JS is blocked in tests, so the wrapper is absent: warning, not failure.
  assert.equal(r.wrapped, false);
});

test('wrapper present (as after site JS) => no wrapper warning', async () => {
  const r = await run(withTable(`<div class="usa-table-container--tyler-scrollable"><table><tbody>${hdr}<tr><td>X</td><td>01/01/2030</td></tr></tbody></table></div>`));
  assert.equal(r.ok, true);
  assert.equal(r.wrapped, true);
  assert.deepEqual(r.warnings, []);
});

test('empty official table is ok with zero records (not a failure)', async () => {
  const r = await run(withTable(`<table><tbody>${hdr}</tbody></table>`));
  assert.equal(r.ok, true);
  assert.deepEqual(r.records, []);
});

test('missing table fails', async () => {
  const r = await run(REAL.replace(TABLE_RE, '<p>No table here</p>'));
  assert.equal(r.ok, false);
});

test('two matching tables fail (no guessing)', async () => {
  const t = `<table><tbody>${hdr}<tr><td>A</td><td>01/01/2030</td></tr></tbody></table>`;
  const r = await run(withTable(t + t));
  assert.equal(r.ok, false);
  assert.match(r.reason, /2 tables/);
});

test('extra column fails', async () => {
  const r = await run(withTable('<table><tbody><tr><td>Name</td><td>Expiration Term</td><td>Notes</td></tr></tbody></table>'));
  assert.equal(r.ok, false);
});

test('data row with wrong cell count fails', async () => {
  const r = await run(withTable(`<table><tbody>${hdr}<tr><td>A</td><td>01/01/2030</td><td>x</td></tr></tbody></table>`));
  assert.equal(r.ok, false);
});

test('CloudFront 403 page fails', async () => {
  const r = await run(fx('cloudfront-403.html'));
  assert.equal(r.ok, false);
});

test('markup inside a name stays literal text; non-date term kept verbatim with warning', async () => {
  const r = await run(withTable(`<table><tbody>${hdr}<tr><td>&lt;img src=x onerror=alert(1)&gt; Co.</td><td>Indefinite</td></tr></tbody></table>`));
  assert.equal(r.ok, true);
  assert.equal(r.records[0].name, '<img src=x onerror=alert(1)> Co.');
  assert.equal(r.records[0].expiration_term, 'Indefinite');
  assert.ok(r.warnings.some((w) => w.includes('Indefinite')));
});

test('header using <th> and extra whitespace still matches', async () => {
  const r = await run(withTable('<table><thead><tr><th> Name </th><th>Expiration&nbsp;\n Term</th></tr></thead><tbody><tr><td>  B  Co  </td><td> 02/02/2031 </td></tr></tbody></table>'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.records, [{ name: 'B Co', expiration_term: '02/02/2031' }]);
});
