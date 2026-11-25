// Retrieval engine: one browser navigation -> validate -> extract table ->
// print PDF of THE SAME page -> write one snapshot (json + pdf + metadata).
//
// Usage: node scripts/fetch-debarment.mjs <outDir>
//   exit 0: <outDir>/debarment.json, debarment.pdf, metadata.json
//   exit 1: <outDir>/failure.json  {reason, attempted_at_utc}
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractDebarmentTable } from './extract.mjs';
import { validatePage, SOURCE_URL, USER_AGENT } from './validate.mjs';
import { TZ, pdfFilename, formatEt } from '../site/lib.js';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
const NAV_TIMEOUT_MS = 45_000;
const WRAPPER_TIMEOUT_MS = 10_000;
// Chosen after side-by-side review on 2026-11-25 (see report §PDF review).
export const PDF_SCALE = 0.8;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const playwrightVersion = createRequire(import.meta.url)('playwright/package.json').version;

function toolCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; }
}

export function snapshotId(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20261125T120500Z
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One attempt. Throws Error(reason) on any validation failure.
export async function captureOnce(browser, { pdfScale = PDF_SCALE } = {}) {
  const context = await browser.newContext({ userAgent: USER_AGENT, timezoneId: TZ, locale: 'en-US' });
  try {
    const page = await context.newPage();
    const resp = await page.goto(SOURCE_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    const status = resp ? resp.status() : null;
    const title = (await page.title()).trim();
    const h1 = await page.locator('h1').first().innerText({ timeout: 2_000 }).catch(() => '');
    const errors = validatePage({ status, finalUrl: page.url(), title, h1: h1.trim() });
    if (errors.length) throw new Error(`Page validation failed: ${errors.join(' ')}`);

    const warnings = [];
    await page.waitForSelector('.usa-table-container--tyler-scrollable table', { timeout: WRAPPER_TIMEOUT_MS })
      .catch(() => warnings.push('Site table-wrapper script did not run within 10 s.'));
    await page.evaluate(() => document.fonts.ready);

    const ex = await page.evaluate(`(${extractDebarmentTable.toString()})(document)`);
    if (!ex.ok) throw new Error(`Table extraction failed: ${ex.reason}`);
    warnings.push(...ex.warnings);

    const retrievedAt = new Date();
    const retrievedEt = formatEt(retrievedAt);
    const small = 'font-size:8px;font-family:Arial,sans-serif;width:100%;padding:0 0.4in;display:flex;justify-content:space-between;';
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      scale: pdfScale,
      margin: { top: '0.55in', bottom: '0.55in', left: '0.4in', right: '0.4in' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="${small}"><span>Retrieved ${esc(retrievedEt)}</span><span>${esc(SOURCE_URL)}</span></div>`,
      footerTemplate: `<div style="${small}"><span>Printed copy of the official page; source of record is the URL above.</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Generated PDF lacks %PDF- header.');

    const responseBody = await resp.body();
    return { retrievedAt, status, finalUrl: page.url(), records: ex.records, warnings, pdf, responseBody };
  } finally {
    await context.close();
  }
}

export function buildSnapshotFiles(cap, { pdfScale = PDF_SCALE } = {}) {
  const id = snapshotId(cap.retrievedAt);
  const data = { schema_version: 1, snapshot_id: id, source_url: SOURCE_URL, records: cap.records };
  const dataBuf = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  const metadata = {
    schema_version: 1,
    snapshot_id: id,
    status: 'success',
    source_url: SOURCE_URL,
    final_url: cap.finalUrl,
    http_status: cap.status,
    retrieved_at_utc: cap.retrievedAt.toISOString(),
    retrieved_at_et: formatEt(cap.retrievedAt),
    timezone: TZ,
    record_count: cap.records.length,
    list_state: cap.records.length === 0 ? 'empty' : 'listed',
    pdf_download_name: pdfFilename(cap.retrievedAt),
    pdf_sha256: sha256(cap.pdf),
    pdf_bytes: cap.pdf.length,
    pdf_scale: pdfScale,
    data_sha256: sha256(dataBuf),
    response_body_sha256: sha256(cap.responseBody),
    user_agent: USER_AGENT,
    playwright_version: playwrightVersion,
    tool_commit: toolCommit(),
    warnings: cap.warnings,
  };
  return {
    'debarment.json': dataBuf,
    'debarment.pdf': cap.pdf,
    'metadata.json': Buffer.from(JSON.stringify(metadata, null, 2) + '\n'),
  };
}

async function main(outDir) {
  if (!outDir) { console.error('usage: fetch-debarment.mjs <outDir>'); process.exit(2); }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  let lastError;
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const cap = await captureOnce(browser);
        const files = buildSnapshotFiles(cap);
        for (const [name, buf] of Object.entries(files)) await writeFile(join(outDir, name), buf);
        const meta = JSON.parse(files['metadata.json']);
        console.log(`OK attempt ${attempt}: ${meta.record_count} records, snapshot ${meta.snapshot_id}, pdf ${meta.pdf_bytes} bytes`);
        for (const w of meta.warnings) console.log(`::warning title=Extraction::${w}`);
        return 0;
      } catch (e) {
        lastError = e;
        console.log(`::warning title=Attempt ${attempt} failed::${String(e.message).slice(0, 500)}`);
        if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
  } finally {
    await browser.close();
  }
  const failure = { reason: String(lastError?.message || lastError).slice(0, 500), attempted_at_utc: new Date().toISOString() };
  await writeFile(join(outDir, 'failure.json'), JSON.stringify(failure, null, 2) + '\n');
  console.log(`::error title=Retrieval failed::${failure.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv[2]));
}
