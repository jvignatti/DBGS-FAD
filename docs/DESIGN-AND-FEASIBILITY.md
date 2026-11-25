# Vermont Debarment Verification — Phase 0 / Phase 1 Report

**Date:** 2026-11-25 · **Status:** built. See §11 for what was built, final decisions and known limitations. Sections 1–10 are the original assessment.
**Nature:** unofficial personal side-project prototype. Not an official state service.
**Repository:** https://github.com/jvignatti/DBGS-FAD
**Evidence folder:** `docs/evidence/2026-11-25/` (raw source HTML, response headers, two spike PDFs, `SHA256SUMS.txt`)

Labels used throughout:
- **[VERIFIED]** — I executed it or read it today, and the evidence is cited.
- **[DOCS]** — taken from current GitHub documentation, read today. Not exercised.
- **[PROPOSED]** — my recommendation. Needs your approval.
- **[UNTESTED]** — an assumption that has not been checked yet.

---

## 1. Feasibility assessment

**Verdict: feasible, with one blocker and one governance question that must be resolved first.**

| # | Finding | Label |
|---|---|---|
| F1 | A server-side GET of the official page returns HTTP 200 (38,848 bytes, Drupal 10.6.19 behind CloudFront plus F5 "volt-adc"). There was no redirect: the final URL equals the requested URL. | VERIFIED |
| F2 | **The previous browser prototype's failure is explained.** The response carries no `Access-Control-Allow-Origin` header, even when an `Origin` header is sent. Cross-origin `fetch()` from any site will always be blocked by the browser. This is by design on BGS's side, not a network glitch. | VERIFIED |
| F3 | **The site's firewall blocks automated user agents.** `curl/8.0` gets 403, and so does a UA containing `HeadlessChrome`. A normal Chrome UA gets 200, and so does an honest self-identifying UA such as the adopted UA `Mozilla/5.0 (compatible; DBGS-FAD/0.1; +https://github.com/jvignatti/DBGS-FAD)` also gets 200. | VERIFIED |
| F4 | **Headless Chromium with default settings is blocked.** It received a CloudFront "403 ERROR – Request blocked" page and **printed it as a normal-looking PDF**. This is the exact failure FR-01 and FR-08 must catch. Evidence: `spike-headless-default-UA-403-error.pdf` (Playwright Chromium, default UA). | VERIFIED |
| F5 | With the honest UA, headless Chromium printed the real official page: Letter pages, selectable text, all 9 records present. Evidence: `pdf-review-scale-*.pdf`. | VERIFIED (locally) |
| F6 | GitHub runner → BGS connectivity. Probe run [45659588698](https://github.com/jvignatti/DBGS-FAD/actions/runs/45659588698) (commit fc64b18, 2026-11-25), using the DBGS-FAD UA:<br>• plain GET: 200<br>• Playwright Chromium 1.65.0: status 200, exact final URL, title "Debarment List \| Buildings and General Services"<br>• exactly 1 matching table, 9 data rows, wrapper present after JS<br>Verdict PASS. This is a single run: it doesn't show that the firewall will keep allowing runners. | VERIFIED |
| F7 | GitHub Actions + Pages can technically meet FR-01 to FR-09 (details in §5). | DOCS + PROPOSED |

## 2. Verified understanding of the official source structure

**[VERIFIED]** from `source-page-raw.html` and the site's own `table-wrapper.js`:

1. **The `usa-table-container--tyler-scrollable` wrapper in the spec is not in the server HTML.** The site's script `/themes/custom/agency_template/assets/js/table-wrapper.js` adds that wrapper client-side to **every** table inside `.usa-layout-docs__main`. Consequences:
   - The wrapper only exists after JavaScript runs. That is one more reason to use a real browser, and to wait for the script.
   - The wrapper does not identify *this* table. Any future table on the page gets the same wrapper.
2. The table has **no id and no class**. The only inline attributes are `border="1" … style="width: 914px;"`.
3. The header row uses **`<td>`, not `<th>`**, inside `<tbody>`. The header text is literally `Name` and `Expiration Term&nbsp;` (trailing non-breaking space).
4. Data cells contain **pasted Word formatting**, for example `<span style="font-size:12.0pt"><span style="font-family:Aptos">…`. Several also contain trailing `&nbsp;` or spaces. Text must be read from the cell's text content, not from its HTML.
5. Special characters are present and must be preserved: `&amp;` (decodes to `&`), `’` (a curly apostrophe in "Valley Floor’s"), and a straight `'` (in "Delair's").
6. Today the table lists 9 records. They match the example list in your spec exactly, in the same order.
7. The page itself states: "Names of businesses will automatically be removed from the Debarment List at the end of the debarment period." This supports FR-02's rule not to filter expired records ourselves.
8. Third-party scripts on the page: Google Analytics, Google Translate, FontAwesome CDN. A headless visit will load these, and it registers as a visit in BGS's analytics. The impact is small, and it should be documented.

**[PROPOSED] Identification rule.** Each step must pass, or the run fails:
- (a) The final URL is exactly `https://bgs.vermont.gov/purchasing-contracting/debarment`, with HTTP status 200.
- (b) The page `<title>` and the `<h1>` both contain "Debarment List" (not the CloudFront "ERROR" title).
- (c) Among tables inside the main content area, **exactly one** has a first row whose cells are `Name` and `Expiration Term` after whitespace and `&nbsp;` normalization. Zero matches fails the run. Two or more matches also fail the run; the tool will not guess.
- (d) That table is inside the `usa-table-container--tyler-scrollable` wrapper. This is a corroborating check: if it fails, the run logs a warning but does not fail, because the wrapper is cosmetic JavaScript.
- (e) Every data row has exactly 2 cells.

## 3. Proposed technical architecture [PROPOSED]

```
bgs.vermont.gov ──HTTPS──> GitHub Actions runner (ubuntu, scheduled + manual)
                              │ Playwright Chromium, honest identifying UA
                              │ 1 navigation → validate → wait for table-wrapper JS
                              │ SAME page object →  extract table  +  page.pdf()
                              │ build snapshot dir: debarment.json, debarment.pdf, metadata.json
                              │ validation gate (schema, PDF magic bytes, sha256, counts match)
                              ▼
                       actions/deploy-pages (whole site replaced atomically)
                              ▼
                 https://jvignatti.github.io/DBGS-FAD/  (static HTML/CSS/JS, no framework)
```

Key design points:
- **One browser document feeds everything.** The table is extracted, and the PDF is printed, from the same Playwright `page` with no reload in between. This satisfies FR-03 and FR-09.
- **Versioned snapshot paths.** Files are published as `snapshots/<snapshot_id>/…`. A small `status.json` at the site root (fetched with `cache: 'no-store'`) points to the current snapshot. The PDF URL changes with every snapshot, so a browser can never mix an old PDF with a new table.
- **The download filename comes from retrieval time**, using the HTML `download` attribute, e.g. `Vermont_BGS_Debarment_2026-11-25_1140.pdf` (America/New_York). Same-origin, so no CORS issue.
- **PDF print settings** to evaluate: Letter, portrait, `printBackground: true`, `displayHeaderFooter: true` with source URL, title, page X/Y, and the retrieval timestamp in **America/New_York**. The runner clock is UTC, so the time zone must be set explicitly.

### Failure communication (FR-08) — the hard part

Pages deploys are all-or-nothing. A failed run deploys nothing, so the old site stays up. That is good for data integrity, but by itself it cannot tell staff "the last attempt failed."

| Option | How | Trade-off |
|---|---|---|
| **A. Re-deploy last good + failure status** | On failure, the workflow downloads the **currently live** snapshot files from the Pages site, verifies their sha256 against the live metadata, writes a new `status.json` (last_attempt = failed, reason), and re-deploys. | No repo growth. The failure is visible to staff. If Pages itself is down, the failure deploy also fails, and the stale warning still covers that case. Moderate complexity. |
| **B. Latest-snapshot branch** | On success, force-push one commit to an orphan `snapshot` branch. The deploy reads from it, so a failure run can rebuild status from the branch. | Durable copy outside Pages. Commits count as repo activity (helps the 60-day rule, see §5). Uses `contents: write`. Unreferenced blobs accumulate slowly. |
| **C. Staleness only** | The frontend shows a warning when `retrieved_at` is older than the threshold. Failures are visible only in Actions logs. | Simplest. Does not meet "distinguish last success from latest attempt" (FR-08). |

**Recommendation: A, plus C as a safety net.** A meets FR-08 without growing the repo. C still warns if every run, including failure deploys, stops entirely.

## 4. Recommended repository structure [PROPOSED]

Your proposed layout, with these changes:

```
DBGS-FAD/
├─ .github/workflows/update-debarment.yml   # schedule (America/New_York) + workflow_dispatch
├─ .github/dependabot.yml                   # NEW: keeps pinned actions/npm current via PRs (optional, decision D9)
├─ scripts/fetch-debarment.mjs              # retrieve + extract + pdf + metadata (one browser session)
├─ scripts/extract.mjs                      # NEW: pure function, DOM → records; unit-testable against fixtures
├─ scripts/build-site.mjs                   # NEW: assembles dist/ + status.json, runs validation gate
├─ site/ index.html  styles.css  app.js
├─ tests/fixtures/                          # copies of real HTML incl. today's page + the 403 page + synthetic variants
├─ tests/extraction.test.mjs                # node:test (built in, no test framework dependency)
├─ docs/                                    # this report, evidence, runbook, ADR-style decisions
├─ package.json  package-lock.json  .gitignore  README.md
```
Why the changes:
- `extract.mjs` is split out so extraction can be tested without network access.
- `build-site.mjs` is split out so the validation gate is one place.
- `node:test` instead of Jest or Vitest, to avoid an unjustified dependency.

**Only runtime dependency:** `playwright` (exact version, lockfile). No frontend framework.

## 5. GitHub Actions and GitHub Pages limitations

| Topic | Fact | Label | Implication |
|---|---|---|---|
| Schedule time zone | "By default UTC… optionally specify a timezone using an IANA timezone string" | DOCS | Use `America/New_York`; DST is handled. Still to verify in a real run. |
| Schedule reliability | Can be delayed under load; "some queued jobs may be dropped" | DOCS | The UI must show the actual retrieval time, never "real-time". |
| **60-day auto-disable** | "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." | DOCS | **Artifact-only deploys create no commits, so the schedule will silently stop after ~60 days.** Mitigations: option B's commits (whether bot commits count is UNTESTED), a documented calendar reminder for a maintainer, or the stale warning as the last line of defense. **Decision D6.** |
| Default branch only | Schedules run only on the default branch | DOCS | Fine. |
| Pages size and bandwidth | 1 GB site, 100 GB/month soft limit, 10-minute deploy timeout | DOCS | Each snapshot is ~170 KB. Not a concern. |
| Access control | Private (viewer-restricted) Pages requires **GitHub Enterprise Cloud** | DOCS | **On your current setup the site is readable by anyone on the internet.** The data is public, but the site would look like a state tool. See §6. |
| Cost | Public repo: standard Actions minutes and Pages are free | General knowledge, not re-verified today | Private repo on Free plan: Pages unavailable. |
| Pages caching | Pages serves with short CDN caching (about 10 minutes) | UNTESTED | Handled by versioned snapshot paths plus `no-store` on `status.json`. |
| Runner → BGS connectivity | — | **UNTESTED, blocker** | First task once approved: a one-off `workflow_dispatch` probe that only reports status codes. |

## 6. Security and data governance

1. **Authorization — resolved (D1).** This is a personal side-project prototype, published from a personal account. The page and README state plainly that it is unofficial and not affiliated with BGS or any state office.
2. **User-agent / WAF question (governance).** BGS's firewall deliberately rejects `HeadlessChrome`. Sending an honest, self-identifying UA is transparent: it names the tool and is not a disguised browser. It does, however, get past a filter BGS chose to put there. My recommendation:
   - (a) Use the honest UA, not a fake desktop-Chrome string.
   - (b) Make 1 scheduled request per weekday (D4).
   - (c) Ideally get a short OK from BGS or ADS, or at least document the decision.
   - I will **not** use stealth plugins, headed-under-Xvfb tricks, or rotating UAs. **D2**.
3. **No staff data.** There is no analytics, no external fonts, and no CDN on our page. Search is pure client-side. Our site has no forms and no cookies. A strict CSP `<meta>` allows only same-origin resources.
4. **Rendering safety.** Names are inserted only with `textContent`, never `innerHTML`.
5. **Least privilege.**
   - Workflow-level `permissions: {}`.
   - The deploy job gets only `pages: write` and `id-token: write`, plus `contents: read`.
   - `contents: write` is added only if option B is chosen.
   - `concurrency: { group: pages, cancel-in-progress: false }` prevents overlapping publishes.
   - Third-party actions are pinned to full commit SHAs.
   - `npm ci` with the lockfile. Only the `chromium` browser is installed, with `--with-deps`.
6. **No trigger endpoint.** Manual runs happen only through the GitHub UI by repo collaborators. Nothing in the frontend can trigger a run, and no token ever reaches the frontend.
7. **Disclaimer.** A permanent notice on the page will say that this is an independently generated copy, that the official source is BGS (linked), and that it shows the list as of the displayed retrieval time.
8. **PII.** The official page contains a named state contact (phone and email). It will appear in the PDF because the PDF must be the unmodified page. We do not extract it into JSON.

## 7. Implementation plan (after approval)

| Phase | Work | Exit gate |
|---|---|---|
| 0b | Commit README and this doc. Run a **network probe workflow** from a runner: one GET with the honest UA, report status, final URL, and title. Nothing is deployed. | Runner gets 200 + correct title, **or** we stop and re-plan (D3) |
| 2 | `extract.mjs` + fixtures (test first): real page, 403 page, empty table, missing table, two matching tables, extra column, reordered markup. Then `fetch-debarment.mjs` (retries: 2, timeouts, validation) and a PDF settings review with you. | Tests executed and passing. You approve the PDF look. |
| 3 | Frontend: title, source link, last-success and last-attempt times, count, search, table, Download PDF, stale banner, failure banner. Keyboard and screen-reader pass. | Manual check in Edge and Chrome. |
| 4 | Workflow: schedule, dispatch, permissions, concurrency, validation gate, Pages deploy, failure re-deploy (option A). Forced-failure drill: point at a bad URL and confirm the old snapshot is kept and the failure shown. | Drill executed and passing. |
| 5 | README, runbook (manual run, troubleshooting, the 60-day rule, what to do if BGS changes the page), acceptance checklist. | You sign off. |

## 8. Unresolved decisions (need your call)

| ID | Decision | My recommendation |
|---|---|---|
| D1 | ~~Authorization to publish under a personal account~~ | **Decided:** personal side-project prototype. |
| D2 | User-agent approach given BGS's headless block (§6.2) | **DECIDED 2026-11-25:** keep the project acronym. UA = `Mozilla/5.0 (compatible; DBGS-FAD/0.1; +https://github.com/jvignatti/DBGS-FAD)`. Honest, links back to the repo, 1 run per weekday. |
| D3 | If GitHub runners are blocked by BGS's firewall: stop, or evaluate state-hosted alternatives (e.g. a scheduled job on a state machine or Azure, publishing to SharePoint) | Decide only if the probe fails. |
| D4 | ~~Schedule times~~ | **DECIDED 2026-11-25:** once a day, 07:00 America/New_York, Monday–Friday. Cron `0 7 * * 1-5` with `timezone: America/New_York`. Manual runs remain available any time. |
| D5 | Stale threshold | **Revised for the weekday schedule.** A fixed hour count would raise a false alarm every weekend, because Friday 07:00 to Monday 07:00 is 72 hours. Proposal: the page computes the most recent *expected* run (the last weekday 07:00 ET), plus a 3-hour grace for GitHub delays. If the last success is older than that, show a yellow "stale" banner. If it is more than one expected run behind, show a red banner that sends staff to the official site. |
| D6 | 60-day inactivity mitigation | Option B commits, if verified to count, plus a documented quarterly check. |
| D7 | Failure-status mechanism | Option A + C (§3) |
| D8 | Empty official table: publish automatically, or hold for human confirmation? Also: should a large sudden drop (e.g. 9 → 1) be held? | Publish an empty table with an explicit "official table lists no entities" notice. Do **not** add drop-thresholds unless you want them, because they would be our rule, not BGS's. |
| D9 | Dependabot for pinned versions | Yes (PRs only, no auto-merge) |
| D10 | Filename timestamp | `Vermont_BGS_Debarment_YYYY-MM-DD_HHmm.pdf`, retrieval time in **America/New_York**, 24-hour. Confirm local time, not UTC. |
| D11 | Unexpected Expiration Term format (not MM/DD/YYYY, e.g. "Indefinite") | Publish verbatim. Log a warning, do not fail. Never reinterpret the value. |
| D12 | PDF retention | Latest snapshot only. No history, unless you need an audit trail. |

## 9. Assumptions requiring your confirmation

1. Users can reach `*.github.io` from their networks. Some networks block it.
2. Today's 9 records are real current data. They match your examples, but I treat them as live data, never as fixtures for production.
3. The PDF should be the **whole** page, including navigation and footer, not just the article. That is "printed version of the original official webpage." Trimming it would alter the official content.
4. The browser's built-in PDF header and footer (date, title, URL, page X/Y) are acceptable, with the date made explicit in America/New_York.
5. Twice a day is enough. The tool is documentation support, not a real-time check.

## 10. Blockers

1. ~~[Blocker, technical]~~ **Resolved 2026-11-25:** the runner reached BGS, and the probe passed (F6). Phase 0b is complete.
2. ~~[Blocker, governance]~~ **Resolved 2026-11-25:** D1 and D2 decided.
3. **[Not a blocker, noted]** In the spike PDF:
   - The table's **right border is clipped**: the fixed `width:914px` is wider than the printable area. All text is visible.
   - A **horizontal scrollbar artifact** from the site's scroll wrapper is printed over "Dirk Anderson" on page 2.
   - The table splits across pages 1–2, but rows are not cut.
   - Fixing these means either scaling the print (e.g. `scale: 0.9`), which does not alter content, or injecting print CSS, which **does** alter the official page's appearance. That is your call in Phase 2. I will show you both side by side.


## 11. Build status, final decisions and limitations (2026-11-25)

Plan: `docs/IMPLEMENTATION-PLAN.md`. All 40 tests were **executed and pass** locally (`npm test`):
- 15 extraction/validation
- 11 search/time/staleness
- 8 site build and gate
- 6 browser end-to-end

### Final decisions

| ID | Decision | Implemented in |
|---|---|---|
| D1 | Personal side-project prototype, unofficial | README, page notice |
| D2 | Honest UA `Mozilla/5.0 (compatible; DBGS-FAD/0.1; +https://github.com/jvignatti/DBGS-FAD)` | `scripts/validate.mjs` |
| D3 | If runners are ever blocked: stop and re-plan. No workarounds. | README "Operating" |
| D4 | 07:00 America/New_York, Mon–Fri, plus manual dispatch | `update-debarment.yml` |
| D5 | Yellow when one expected run is missed beyond the 3 h grace; red when two or more are missed | `site/lib.js` `stalenessLevel` |
| D6 | **My call:** option B (snapshot commits) was not built, because D7 chose option A. Mitigation is the documented ~45-day check, plus the red banner when updates stop. | README |
| D7 | Option A + C: re-publish the verified live snapshot with a failed-attempt status. Only a confirmed 404 publishes "no data"; any other error deploys nothing. | `scripts/build-site.mjs` |
| D8 | Empty table is published with an explicit notice. No drop thresholds. | `extract.mjs`, `app.js` |
| D9 | Dependabot monthly PRs for actions and npm. No auto-merge. | `.github/dependabot.yml` |
| D10 | `Vermont_BGS_Debarment_YYYY-MM-DD_HHmm.pdf`, retrieval time in ET, 24-hour | `site/lib.js` `pdfFilename` |
| D11 | A non-date term is published verbatim, with a warning in the run log | `extract.mjs` |
| D12 | Latest snapshot only. No history. | `build-site.mjs` |

### PDF review (Phase 2 gate)

Evidence: `docs/evidence/2026-11-25/pdf-review-scale-*.pdf`. All three renders came from the live site with Playwright Chromium.

| Scale | Result |
|---|---|
| 1.0 | Table split across pages 1–2. Right border clipped. 5 pages. |
| **0.8 (chosen)** | **All 9 rows on page 1.** Every word and date is visible. Only the table's right border line is clipped, because the official table has a fixed 914 px width. 4 pages. |
| 0.7 | The site switches to its desktop layout, and a site rendering glitch hides the "Additional Information" heading on page 2. Rejected. |

The earlier Edge spike showed a scrollbar artifact. It does not appear with Playwright at any scale. The clipped border line is accepted rather than injecting CSS into the official page (FR-03: do not alter the official content).

### Known limitations

1. **Single-run connectivity evidence.** BGS's firewall let a GitHub runner through on 2026-11-25. It could change its policy at any time; if so, runs fail visibly and are not worked around.
2. **The schedule is best-effort.** GitHub may delay or drop scheduled runs. The page shows real retrieval times and stale banners.
3. **60-day auto-disable** (D6). A human must keep an eye on it.
4. **The site is public.** GitHub Pages access control needs Enterprise Cloud. All content is already public, but anyone with the URL can view the site.
5. **Some networks block `*.github.io`.** Reachability from every user network is not guaranteed.
6. **The PDF's right table border is clipped** (cosmetic; see above).
7. **The headless visit loads BGS's Google Analytics and Translate scripts** as part of rendering the page faithfully. It counts as one visit per run in their analytics.
8. **The PDF is not cryptographically signed.** Integrity is a sha256 in `metadata.json` published on the same site, which detects corruption, not a malicious publisher.
10. **PDF text layer from the Linux runner sometimes drops a space between body-text words** when copied (e.g. "OPCHome"), although it looks correct on screen. Table names and dates copy cleanly. The cause is font rendering on the runner; it was not seen in PDFs made on Windows.
9. **The failure banner depends on the failure run reaching Pages.** If Pages itself is down, only the stale banner applies.

### Acceptance checklist

| # | Criterion | Status |
|---|---|---|
| 1 | Reachable via a regular browser URL | Met: https://jvignatti.github.io/DBGS-FAD/ (first deploy 2026-11-25 18:52Z) |
| 2 | No installation for staff | Met: static site |
| 3 | Automatic retrieval | Verified via manual run on GitHub (2026-11-25). First scheduled 07:00 ET run: pending. |
| 4 | Records displayed accurately | Verified locally against the live page, 2026-11-25 |
| 5 | Search | Verified (browser tests) |
| 6 | Direct PDF download of the official page | Verified locally (`download` attribute, same origin) |
| 7 | Retrieval timestamp visible | Verified |
| 8 | Table and PDF from the same retrieval | By construction (same `page` object) plus the sha256 gate |
| 9 | Failures not misleading | Verified (browser tests: failure, stale, critical, no-data) |
| 10 | Maintainable, documented repo | README runbook, this report, plan |
| 11 | No staff data collected | Verified: no foreign requests in browser tests; CSP same-origin |
| 12 | Limitations documented | This section |
