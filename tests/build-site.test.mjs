import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshotFiles } from '../scripts/fetch-debarment.mjs';
import { verifySnapshot, buildSuccess, buildFailure } from '../scripts/build-site.mjs';

const cap = {
  retrievedAt: new Date('2026-11-25T12:05:00Z'),
  status: 200,
  finalUrl: 'https://bgs.vermont.gov/purchasing-contracting/debarment',
  records: [{ name: 'Valley Floor’s, Inc.', expiration_term: '10/16/2028' }],
  warnings: [],
  pdf: Buffer.from('%PDF-1.7\nfake test pdf\n'),
  responseBody: Buffer.from('<html></html>'),
};
const files = buildSnapshotFiles(cap);
const ID = '20261125T120500Z';
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'dbgs-'));

async function snapshotDir(f = files) {
  const d = await tmp();
  for (const [n, b] of Object.entries(f)) await writeFile(join(d, n), b);
  return d;
}
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('buildSnapshotFiles: id, filename, sha256 consistent', () => {
  const m = JSON.parse(files['metadata.json']);
  assert.equal(m.snapshot_id, ID);
  assert.equal(m.pdf_download_name, 'Vermont_BGS_Debarment_2026-11-25_0705.pdf');
  assert.equal(m.record_count, 1);
  assert.doesNotThrow(() => verifySnapshot(files));
});

test('gate rejects tampered PDF, wrong count, non-PDF, mismatched ids', () => {
  assert.throws(() => verifySnapshot({ ...files, 'debarment.pdf': Buffer.from('%PDF-1.7\nother\n') }), /sha256/);
  assert.throws(() => verifySnapshot({ ...files, 'debarment.pdf': Buffer.from('<html>403</html>') }), /PDF/);
  const m = JSON.parse(files['metadata.json']);
  assert.throws(() => verifySnapshot({ ...files, 'metadata.json': Buffer.from(JSON.stringify({ ...m, record_count: 5 })) }), /count/);
  assert.throws(() => verifySnapshot({ ...files, 'metadata.json': Buffer.from(JSON.stringify({ ...m, snapshot_id: '20991231T000000Z' })) }), /snapshot_id/);
});

test('success build: versioned snapshot + status.json + site files', async () => {
  const dist = await tmp();
  await buildSuccess({ snapshotDir: await snapshotDir(), siteDir: SITE, distDir: dist, runUrl: 'https://x/run/1' });
  const st = await readJson(join(dist, 'status.json'));
  assert.equal(st.current_snapshot, ID);
  assert.equal(st.last_success_utc, '2026-11-25T12:05:00.000Z');
  assert.equal(st.last_attempt.result, 'success');
  assert.deepEqual((await readdir(join(dist, 'snapshots', ID))).sort(), ['debarment.json', 'debarment.pdf', 'metadata.json']);
  assert.ok((await readdir(dist)).includes('index.html'));
});

test('success build refuses an invalid snapshot (nothing written)', async () => {
  const dist = await tmp();
  const bad = await snapshotDir({ ...files, 'debarment.pdf': Buffer.from('%PDF-tampered') });
  await assert.rejects(buildSuccess({ snapshotDir: bad, siteDir: SITE, distDir: dist, runUrl: '' }), /sha256/);
  assert.deepEqual(await readdir(dist), []);
});

const liveStatus = { schema_version: 1, current_snapshot: ID, last_success_utc: '2026-11-25T12:05:00.000Z', last_attempt: { at_utc: '2026-11-25T12:05:00.000Z', result: 'success' } };
function fakeFetch(map) {
  return async (url) => {
    const key = Object.keys(map).find((k) => url.endsWith(k));
    if (!key) return new Response('nope', { status: 404 });
    const v = map[key];
    if (v instanceof Error) throw v;
    if (typeof v === 'number') return new Response('err', { status: v });
    return new Response(v, { status: 200 });
  };
}
const failure = { reason: 'Page validation failed: HTTP status 403', attempted_at_utc: '2026-11-26T12:01:00.000Z' };

test('failure build keeps verified previous snapshot and records the failed attempt', async () => {
  const dist = await tmp();
  await buildFailure({
    failure, siteDir: SITE, distDir: dist, pagesUrl: 'https://p/', runUrl: 'https://x/run/2',
    fetchImpl: fakeFetch({
      'status.json': JSON.stringify(liveStatus),
      [`${ID}/debarment.json`]: files['debarment.json'],
      [`${ID}/debarment.pdf`]: files['debarment.pdf'],
      [`${ID}/metadata.json`]: files['metadata.json'],
    }),
  });
  const st = await readJson(join(dist, 'status.json'));
  assert.equal(st.current_snapshot, ID);
  assert.equal(st.last_success_utc, liveStatus.last_success_utc);
  assert.equal(st.last_attempt.result, 'failure');
  assert.match(st.last_attempt.reason, /403/);
  assert.deepEqual(await readFile(join(dist, 'snapshots', ID, 'debarment.pdf')), files['debarment.pdf']);
});

test('failure build when site never deployed (404) publishes explicit no-data status', async () => {
  const dist = await tmp();
  await buildFailure({ failure, siteDir: SITE, distDir: dist, pagesUrl: 'https://p/', runUrl: '', fetchImpl: fakeFetch({}) });
  const st = await readJson(join(dist, 'status.json'));
  assert.equal(st.current_snapshot, null);
  assert.equal(st.last_attempt.result, 'failure');
});

test('failure build aborts (no deploy) if live site unreachable, 5xx, or snapshot corrupt', async () => {
  const base = { failure, siteDir: SITE, pagesUrl: 'https://p/', runUrl: '' };
  await assert.rejects(buildFailure({ ...base, distDir: await tmp(), fetchImpl: fakeFetch({ 'status.json': new Error('ENOTFOUND') }) }));
  await assert.rejects(buildFailure({ ...base, distDir: await tmp(), fetchImpl: fakeFetch({ 'status.json': 503 }) }));
  await assert.rejects(buildFailure({ ...base, distDir: await tmp(), fetchImpl: fakeFetch({
    'status.json': JSON.stringify(liveStatus),
    [`${ID}/debarment.json`]: files['debarment.json'],
    [`${ID}/debarment.pdf`]: Buffer.from('%PDF-corrupted'),
    [`${ID}/metadata.json`]: files['metadata.json'],
  }) }), /sha256/);
});

test('failure build rejects a malicious snapshot id from live status (path traversal)', async () => {
  await assert.rejects(buildFailure({
    failure, siteDir: SITE, distDir: await tmp(), pagesUrl: 'https://p/', runUrl: '',
    fetchImpl: fakeFetch({ 'status.json': JSON.stringify({ ...liveStatus, current_snapshot: '../../etc' }) }),
  }), /snapshot id/);
});
