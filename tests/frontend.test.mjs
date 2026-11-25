// End-to-end check of the built site in real Chromium. dist/ is served from
// memory via request interception; any request to another origin fails the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildSnapshotFiles } from '../scripts/fetch-debarment.mjs';
import { buildSuccess, buildFailure } from '../scripts/build-site.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const ORIGIN = 'https://dbgs.test/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf' };

const records = [
  { name: 'Two Sisters Mill & Mercantile LLC', expiration_term: '12/26/2026' },
  { name: 'Valley Floor’s, Inc.', expiration_term: '10/16/2028' },
  { name: '<img src=x onerror="window.__xss=1"> Co.', expiration_term: 'Indefinite' },
];
const cap = (recs) => ({
  retrievedAt: new Date('2026-11-25T12:05:00Z'), status: 200,
  finalUrl: 'https://bgs.vermont.gov/purchasing-contracting/debarment',
  records: recs, warnings: [], pdf: Buffer.from('%PDF-1.7\ntest\n'), responseBody: Buffer.from('x'),
});

async function dist(recs) {
  const snap = await mkdtemp(join(tmpdir(), 'dbgs-snap-'));
  for (const [n, b] of Object.entries(buildSnapshotFiles(cap(recs)))) await writeFile(join(snap, n), b);
  const d = await mkdtemp(join(tmpdir(), 'dbgs-dist-'));
  await buildSuccess({ snapshotDir: snap, siteDir: SITE, distDir: d });
  return d;
}

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => browser?.close());

async function open(distDir, now = '2026-11-25T15:00:00Z') {
  const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
  const foreign = [];
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(ORIGIN)) { foreign.push(url); return route.abort(); }
    const rel = decodeURIComponent(new URL(url).pathname.slice(1)) || 'index.html';
    try {
      const body = await readFile(join(distDir, rel));
      return route.fulfill({ status: 200, body, contentType: TYPES[extname(rel)] || 'application/octet-stream' });
    } catch { return route.fulfill({ status: 404, body: 'not found' }); }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.setFixedTime(new Date(now));
  await page.goto(ORIGIN);
  await page.waitForFunction(() => document.getElementById('last-success').textContent !== 'Loading…');
  return { page, foreign, errors, ctx };
}

test('success: rows, timestamps, download link, local search, no foreign requests', async () => {
  const { page, foreign, errors, ctx } = await open(await dist(records));
  assert.equal(await page.locator('#rows tr').count(), 3);
  assert.equal(await page.textContent('#last-success'), 'Nov 25, 2026, 7:05 AM EST');
  assert.equal(await page.textContent('#count-total'), '3');
  const dl = page.locator('#download');
  assert.equal(await dl.getAttribute('href'), 'snapshots/20261125T120500Z/debarment.pdf');
  assert.equal(await dl.getAttribute('download'), 'Vermont_BGS_Debarment_2026-11-25_0705.pdf');
  assert.equal(await dl.getAttribute('aria-disabled'), null);
  assert.match(await page.textContent('#banner'), /Up to date/);

  await page.fill('#q', "valley floor's");
  assert.equal(await page.locator('#rows tr').count(), 1);
  assert.equal(await page.textContent('#rows td'), 'Valley Floor’s, Inc.');
  assert.match(await page.textContent('#result-count'), /Showing 1 of 3/);
  await page.fill('#q', '');
  assert.equal(await page.locator('#rows tr').count(), 3);

  assert.deepEqual(foreign, []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('markup in a name is shown as text, never executed', async () => {
  const { page, ctx } = await open(await dist(records));
  assert.equal(await page.locator('#rows img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#rows tr').nth(2).locator('td').first().textContent(), '<img src=x onerror="window.__xss=1"> Co.');
  await ctx.close();
});

test('empty official list shows explicit notice, not an error', async () => {
  const { page, ctx } = await open(await dist([]));
  assert.equal(await page.isVisible('#empty-notice'), true);
  assert.equal(await page.textContent('#count-total'), '0');
  await ctx.close();
});

test('stale and critical banners follow the weekday schedule', async () => {
  const d = await dist(records);
  let o = await open(d, '2026-11-26T15:30:00Z'); // Thu 10:30 ET, Thu run missed
  assert.match(await o.page.textContent('#banner'), /Warning/);
  await o.ctx.close();
  o = await open(d, '2026-11-27T16:00:00Z'); // Fri 11:00 ET, two runs missed
  assert.match(await o.page.textContent('#banner'), /Do not rely/);
  await o.ctx.close();
});

test('failed latest attempt: old snapshot still shown with failure banner', async () => {
  const good = await dist(records);
  const failed = await mkdtemp(join(tmpdir(), 'dbgs-fail-'));
  const fetchImpl = async (url) => {
    const rel = url.replace('https://p/', '');
    try { return new Response(await readFile(join(good, rel)), { status: 200 }); } catch { return new Response('', { status: 404 }); }
  };
  await buildFailure({ failure: { reason: 'HTTP 403', attempted_at_utc: '2026-11-26T12:01:00.000Z' }, siteDir: SITE, distDir: failed, pagesUrl: 'https://p/', fetchImpl });
  const { page, ctx } = await open(failed, '2026-11-26T13:00:00Z');
  assert.match(await page.textContent('#banner'), /most recent retrieval attempt .* failed/);
  assert.match(await page.textContent('#last-attempt'), /failed/);
  assert.equal(await page.locator('#rows tr').count(), 3);
  await ctx.close();
});

test('no snapshot ever: critical banner, download disabled, no table rows', async () => {
  const d = await mkdtemp(join(tmpdir(), 'dbgs-none-'));
  await buildFailure({ failure: { reason: 'x', attempted_at_utc: '2026-11-25T12:01:00.000Z' }, siteDir: SITE, distDir: d, pagesUrl: 'https://p/', fetchImpl: async () => new Response('', { status: 404 }) });
  const { page, ctx } = await open(d);
  assert.match(await page.textContent('#banner'), /No verified snapshot/);
  assert.equal(await page.locator('#download').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('#download').getAttribute('href'), null);
  assert.equal(await page.locator('#rows tr').count(), 0);
  await ctx.close();
});
