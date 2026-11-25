# DBGS-FAD Debarment Snapshot — Implementation Plan

**Goal:** Each weekday at 07:00 ET, snapshot the official BGS debarment page into one validated bundle and publish it on GitHub Pages. The bundle holds the table JSON, a PDF of the original page, and metadata.

**Architecture:**
- Playwright Chromium loads the page once. The same `page` object is used both to extract the table and to print the PDF.
- `build-site.mjs` assembles `dist/` with versioned `snapshots/<id>/` folders plus a `status.json` that is never cached.
- On failure, it re-publishes the verified live snapshot and marks `last_attempt` as failed (option A).
- The static frontend uses no framework.

**Tech stack:** Node 22 (ESM), `playwright@1.65.0` (exact; it is the only dependency), `node:test`, GitHub Actions + Pages.

**Spec:** `docs/DESIGN-AND-FEASIBILITY.md` (requirements FR-01…FR-09).

## Global Constraints

- Source URL is exactly `https://bgs.vermont.gov/purchasing-contracting/debarment`. Any other final URL fails the run.
- UA: `Mozilla/5.0 (compatible; DBGS-FAD/0.1; +https://github.com/jvignatti/DBGS-FAD)`.
- Schedule `0 7 * * 1-5`, `timezone: America/New_York`, plus `workflow_dispatch`.
- Machine timestamps are in UTC (ISO 8601 `Z`). Human-readable timestamps are in America/New_York.
- Download filename: `Vermont_BGS_Debarment_YYYY-MM-DD_HHmm.pdf`, using retrieval time in ET (24-hour clock).
- Records keep official spelling and order. Only surrounding whitespace is trimmed, internal whitespace runs (including `&nbsp;`) collapse to one space, and nothing is filtered, deduplicated, or reinterpreted.
- Names are rendered with `textContent` only. CSP is same-origin only. No analytics, external fonts, or CDNs.
- Workflow `permissions: {}`. Jobs get only what they need. Actions are pinned to SHAs:
  - checkout `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
  - setup-node `949feb2413d6458794dcd2491c4babbbce0c15c1` (v7.1.0)
  - upload-pages-artifact `fc324d3547104276b827a68afc52ff2a11cc49c9` (v5.0.0)
  - deploy-pages `368f82528645a54fb793d4d04e342629a3f51346` (v5.0.1)
- Retries: at most 3 attempts, 30 s apart. Navigation timeout 45 s.
- Staleness (D5): `due` = the most recent weekday 07:00 ET that is at least 3 h ago. Count the expected runs after `last_success` up to `due`: 0 = ok, 1 = yellow, 2 or more = red.

## Review Focus

1. A curly vs straight apostrophe in search: typing `Valley Floor's` must find `Valley Floor’s, Inc.`. Display text must stay unchanged. Tested in `lib.test.mjs`.
2. The CloudFront 403 page served with HTTP 200 would print an error PDF. The title / h1 / table gates must fail it. Tested in `extract.test.mjs` (403 fixture) and `validate.test.mjs`.
3. DST boundaries in the staleness rule and the filename (the March and November switch weeks). Tested in `lib.test.mjs`.
4. A failure run when the previous live site is unreachable must **not** deploy an empty site over good data. Only a confirmed 404 (never deployed) may publish "no data". Tested in `build-site.test.mjs`.
5. A name containing markup (`<img onerror>`) must appear as literal text. Tested in `extract.test.mjs` (stays a string) and by the `textContent` rule in `app.js`.

---

### Task 1: Extraction + page validation

**Files:** Create `package.json`, `scripts/extract.mjs`, `scripts/validate.mjs`, `tests/fixtures/*.html`, `tests/extract.test.mjs`, `tests/validate.test.mjs`.

**Interfaces (produces):**
- `extractDebarmentTable(doc: Document) => {ok:true, records:[{name, expiration_term}], wrapped:boolean, warnings:string[]} | {ok:false, reason:string}`. It must be self-contained, because it is passed to `page.evaluate`.
- `validatePage({status, finalUrl, title, h1}) => string[]`. The array lists errors; empty means the page is valid.

- [ ] Fixtures:
  - `bgs-2026-11-25.html` (copy of the evidence file)
  - `cloudfront-403.html` (a real 403 body)
  - `empty-table.html`, `no-table.html`, `two-tables.html`, `three-columns.html`, `injection.html`
- [ ] Tests:
  - The real page gives 9 records, exactly the spec list in order (e.g. `"Delair's Carpet Barn"`, `"Valley Floor’s, Inc."`, `"Two Sisters Mill & Mercantile LLC"`).
  - Empty table: `ok:true` with `records:[]`.
  - No table, two tables, or three columns: `ok:false`.
  - The 403 page: `ok:false`.
  - Injection name: kept as a literal string.
  - Validation errors on: status ≠ 200, a redirected URL, a title without "Debarment List", and the CloudFront title.
- [ ] Implement. Run `npm test` and confirm it passes. Commit.

### Task 2: Shared pure logic (`site/lib.js`)

**Produces:**
- `normalizeForSearch(s) => string`: NFKD, strips marks, maps `’‘ʼ` to `'`, lowercases, collapses whitespace.
- `filterRecords(records, query) => records`
- `etParts(date) => {y,m,d,hh,mm,weekday}`
- `etToUtc(y,m,d,hh,mm) => Date`
- `pdfFilename(date) => string`
- `formatEt(date) => "Nov 25, 2026, 7:00 AM EST"`
- `stalenessLevel(lastSuccess: Date|null, now: Date) => 'ok'|'stale'|'critical'|'none'`

- [ ] Tests:
  - Filename `2026-11-25T12:05Z` → `Vermont_BGS_Debarment_2026-11-25_0705.pdf`. EDT case: `2027-03-15T11:00Z` → `_0700`.
  - Staleness:
    - Friday success, Monday 09:00 ET → ok
    - Friday success, Monday 10:30 ET → stale
    - Friday success, Tuesday 11:00 ET → critical
    - Mid-day manual success → ok
    - `null` → none
  - Search (the apostrophe case).
- [ ] Implement. Run the tests. Commit.

### Task 3: Retrieval engine (`scripts/fetch-debarment.mjs`)

**Consumes:** Tasks 1 and 2. **Produces:** `node scripts/fetch-debarment.mjs <outDir>`. On success it writes `debarment.json`, `debarment.pdf` and `metadata.json` and exits 0. On failure it exits 1 and writes `<outDir>/failure.json` with `{reason, attempted_at_utc}`.

metadata (schema_version 1) fields:
- `snapshot_id` (`YYYYMMDDTHHmmssZ`)
- `source_url`, `final_url`, `http_status`
- `retrieved_at_utc`, `retrieved_at_et`, `timezone`
- `record_count`, `list_state` (`listed` | `empty`)
- `pdf_download_name`, `pdf_sha256`, `pdf_bytes`
- `data_sha256`, `response_body_sha256`
- `user_agent`, `playwright_version`, `tool_commit`, `warnings`

- [ ] Use one context with `userAgent`, `timezoneId: 'America/New_York'` and `locale: 'en-US'`.
  - Navigation: `goto` → `validatePage` → wait up to 10 s for the wrapper (if it doesn't appear, log a warning, don't fail) → `extract` → `page.pdf` on the same page.
  - PDF settings: Letter, `printBackground`, header/footer with the source URL, the ET retrieval time, and `Page X of Y`.
  - Check the PDF starts with `%PDF-`.
- [ ] PDF review (Phase 2 gate): render scale 1.0 and 0.8, and compare the clipped border and the scrollbar artifact. Pick the smallest scale that shows the whole table. Record the choice in the report.
- [ ] Live run once locally (1 request). Inspect the output. Commit.

### Task 4: Site assembly + validation gate (`scripts/build-site.mjs`)

**Produces:**
- `buildSuccess({snapshotDir, siteDir, distDir, runUrl})`
- `buildFailure({failure, siteDir, distDir, pagesUrl, fetchImpl, runUrl})`
- CLI: `node scripts/build-site.mjs success|failure ...`

status.json:
```
{schema_version:1, current_snapshot:id|null, last_success_utc, last_attempt:{at_utc, result, reason?, run_url}}
```

- [ ] Gate: the PDF magic bytes are present, the sha256 matches the metadata, `record_count === records.length`, and the snapshot ids are equal.
- [ ] Failure mode: GET live `status.json`.
  - On 404, publish "no data".
  - On any other error, throw (nothing is deployed).
  - Otherwise download the snapshot files, verify their sha256, and copy them into dist.
- [ ] Tests use a fake `fetchImpl`: the gate rejects a tampered PDF; a failure keeps the snapshot; a 404 gives no data; a 500 or network error throws. Commit.

### Task 5: Frontend (`site/index.html`, `styles.css`, `app.js`)

- [ ] Page contents:
  - Title "Vermont Debarment Verification", the unofficial-prototype notice, and the official link.
  - Status panel: last success (ET), last attempt and its result, count, staleness banner (yellow/red), failure banner, empty-list notice.
  - Labelled search with a live result count.
  - Table with caption and `scope="col"`.
  - Download link using the `download` attribute.
  - With no data, the page points to the official site.
- [ ] Fetch `status.json` with `cache:'no-store'`. Render all text with `textContent`. CSP meta tag.
- [ ] Verify locally with a static server on dist (Edge): screenshot, keyboard tab order, search. Commit.

### Task 6: Workflow + docs

- [ ] `.github/workflows/update-debarment.yml`:
  - `build` job (contents: read):
    - checkout, setup-node 22, `npm ci`, `npx playwright install --with-deps chromium`, `npm test`
    - fetch (`continue-on-error`); then `build-site success` or `build-site failure`
    - `upload-pages-artifact`
  - `deploy` job: `pages: write`, `id-token: write`, environment `github-pages`.
  - `concurrency: pages`, `cancel-in-progress: false`.
  - The probe workflow becomes `workflow_dispatch` only.
- [ ] README runbook: enable Pages (Source: GitHub Actions, owner), manual run, troubleshooting, the 60-day rule, what to do when BGS changes the page.
- [ ] Update the report with D-decisions and known limitations, plus an acceptance checklist.
- [ ] Push, enable Pages, dispatch, then verify the live run, the deployed `status.json`, and the PDF sha. Commit.
