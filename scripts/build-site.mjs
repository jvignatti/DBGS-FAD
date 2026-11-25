// Assembles the GitHub Pages artifact in distDir and enforces the validation
// gate. Nothing is written unless every check passes.
//
// dist/
//   index.html styles.css app.js lib.js     (from site/)
//   status.json                              (pointer + last attempt; fetched no-store)
//   snapshots/<snapshot_id>/debarment.json|debarment.pdf|metadata.json
//
// CLI:
//   node scripts/build-site.mjs success <snapshotDir>
//   node scripts/build-site.mjs failure <failure.json>
// env: DIST_DIR (default dist), PAGES_URL (failure mode), RUN_URL
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const FILES = ['debarment.json', 'debarment.pdf', 'metadata.json'];
const ID_RE = /^\d{8}T\d{6}Z$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// files: { 'debarment.json': Buffer, 'debarment.pdf': Buffer, 'metadata.json': Buffer }
export function verifySnapshot(files) {
  for (const f of FILES) if (!Buffer.isBuffer(files[f])) throw new Error(`Snapshot missing ${f}`);
  const meta = JSON.parse(files['metadata.json']);
  const data = JSON.parse(files['debarment.json']);
  const pdf = files['debarment.pdf'];
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('debarment.pdf is not a PDF (missing %PDF- header)');
  if (!ID_RE.test(meta.snapshot_id || '')) throw new Error(`Invalid snapshot id ${meta.snapshot_id}`);
  if (data.snapshot_id !== meta.snapshot_id) throw new Error('snapshot_id differs between data and metadata');
  if (sha256(pdf) !== meta.pdf_sha256) throw new Error('PDF sha256 does not match metadata');
  if (sha256(files['debarment.json']) !== meta.data_sha256) throw new Error('Data sha256 does not match metadata');
  if (!Array.isArray(data.records) || data.records.length !== meta.record_count) throw new Error('Record count mismatch between data and metadata');
  if (meta.status !== 'success') throw new Error('Metadata status is not success');
  return { meta, data };
}

async function copySite(siteDir, distDir) {
  for (const f of await readdir(siteDir)) await copyFile(join(siteDir, f), join(distDir, f));
}

async function writeDist({ siteDir, distDir, snapshotFiles, status }) {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await copySite(siteDir, distDir);
  if (snapshotFiles) {
    const dir = join(distDir, 'snapshots', status.current_snapshot);
    await mkdir(dir, { recursive: true });
    for (const f of FILES) await writeFile(join(dir, f), snapshotFiles[f]);
  }
  await writeFile(join(distDir, 'status.json'), JSON.stringify(status, null, 2) + '\n');
}

export async function buildSuccess({ snapshotDir, siteDir, distDir, runUrl = '' }) {
  const files = {};
  for (const f of FILES) files[f] = await readFile(join(snapshotDir, f));
  const { meta } = verifySnapshot(files);
  const status = {
    schema_version: 1,
    current_snapshot: meta.snapshot_id,
    last_success_utc: meta.retrieved_at_utc,
    last_attempt: { at_utc: meta.retrieved_at_utc, result: 'success', run_url: runUrl },
  };
  await writeDist({ siteDir, distDir, snapshotFiles: files, status });
  return status;
}

// Option A (report §3): keep the verified live snapshot, record the failure.
// Only a confirmed 404 for status.json (site never deployed) may publish "no data";
// any other problem throws so the workflow deploys nothing.
export async function buildFailure({ failure, siteDir, distDir, pagesUrl, fetchImpl = fetch, runUrl = '' }) {
  const lastAttempt = { at_utc: failure.attempted_at_utc, result: 'failure', reason: failure.reason, run_url: runUrl };
  const res = await fetchImpl(new URL('status.json', pagesUrl).href, { cache: 'no-store' });
  if (res.status === 404) {
    const status = { schema_version: 1, current_snapshot: null, last_success_utc: null, last_attempt: lastAttempt };
    await writeDist({ siteDir, distDir, snapshotFiles: null, status });
    return status;
  }
  if (!res.ok) throw new Error(`Live status.json returned HTTP ${res.status}; not deploying.`);
  const live = await res.json();
  let snapshotFiles = null;
  if (live.current_snapshot !== null) {
    if (!ID_RE.test(String(live.current_snapshot))) throw new Error(`Invalid snapshot id in live status: ${live.current_snapshot}`);
    snapshotFiles = {};
    for (const f of FILES) {
      const r = await fetchImpl(new URL(`snapshots/${live.current_snapshot}/${f}`, pagesUrl).href);
      if (!r.ok) throw new Error(`Live snapshot file ${f} returned HTTP ${r.status}; not deploying.`);
      snapshotFiles[f] = Buffer.from(await r.arrayBuffer());
    }
    const { meta } = verifySnapshot(snapshotFiles);
    if (meta.snapshot_id !== live.current_snapshot) throw new Error('Live snapshot id mismatch');
  }
  const status = {
    schema_version: 1,
    current_snapshot: live.current_snapshot ?? null,
    last_success_utc: live.last_success_utc ?? null,
    last_attempt: lastAttempt,
  };
  await writeDist({ siteDir, distDir, snapshotFiles, status });
  return status;
}

async function cli([mode, input]) {
  const siteDir = fileURLToPath(new URL('../site/', import.meta.url));
  const distDir = process.env.DIST_DIR || 'dist';
  const runUrl = process.env.RUN_URL || '';
  if (mode === 'success') {
    const st = await buildSuccess({ snapshotDir: input, siteDir, distDir, runUrl });
    console.log(`Built success site for snapshot ${st.current_snapshot}`);
  } else if (mode === 'failure') {
    const failure = JSON.parse(await readFile(input, 'utf8'));
    if (!process.env.PAGES_URL) throw new Error('PAGES_URL is required in failure mode');
    const st = await buildFailure({ failure, siteDir, distDir, pagesUrl: process.env.PAGES_URL, runUrl });
    console.log(`Built failure-status site; keeping snapshot ${st.current_snapshot}`);
  } else {
    throw new Error('usage: build-site.mjs success <snapshotDir> | failure <failure.json>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((e) => { console.error(`::error title=Build site::${e.message}`); process.exit(1); });
}
