# DBGS-FAD — Vermont Debarment List snapshot (prototype)

**Unofficial personal side-project prototype.** It is not affiliated with, or endorsed by, the Vermont Department of Buildings and General Services (BGS) or any state office.

The only authoritative source is the official BGS page:
https://bgs.vermont.gov/purchasing-contracting/debarment

**Site:** https://jvignatti.github.io/DBGS-FAD/ (after Pages is enabled; see Setup).

## What it does

Each weekday at 07:00 America/New_York, GitHub Actions:

1. Loads the official page **once** in Chromium (Playwright), identifying itself as
   `Mozilla/5.0 (compatible; DBGS-FAD/0.1; +https://github.com/jvignatti/DBGS-FAD)`.
2. Validates the page:
   - HTTP 200 and the exact final URL
   - title and heading say "Debarment List"
   - exactly one table headed "Name | Expiration Term"
3. Extracts the table **verbatim**: same order, same spelling. Nothing is filtered, removed, or deduplicated.
4. Prints **the same page** to PDF (Letter, scale 0.8, with the retrieval time and source URL in the margins).
5. Writes one snapshot (`debarment.json`, `debarment.pdf`, `metadata.json` with sha256 hashes). A validation gate checks it before it is published.
6. Publishes the site atomically to GitHub Pages.

For staff, the page shows:
- the last successful retrieval and the most recent attempt
- the number of entities
- a local search box
- the table
- **Download PDF**, which saves `Vermont_BGS_Debarment_YYYY-MM-DD_HHmm.pdf` (named for the retrieval time in ET)

### When something goes wrong

| Situation | What happens |
|---|---|
| BGS blocks or errors, page changed, table missing or ambiguous | 3 attempts, 30 s apart. Then the **previous verified snapshot is re-published** with a "most recent attempt failed" banner, and the Actions run turns red. |
| Official table is genuinely empty | Published, with an explicit "the official table listed no entities" notice. |
| Tests fail, or the build or validation gate fails | **Nothing is deployed.** The live site stays as it was. |
| Live site can't be read during a failure run (except a first-ever 404) | Nothing is deployed. The stale banner covers it. |
| A scheduled update is missed (by more than 3 h after 07:00 ET) | Yellow banner. Two missed updates: red banner pointing to the official site. |

## Setup (one time, repository owner)

1. **Settings → Pages → Build and deployment → Source: "GitHub Actions".**
2. Actions → **Update debarment snapshot** → **Run workflow** (first run).
3. Open the site URL. If `*.github.io` doesn't load on your network, try another network. Some networks block it.

## Operating

- **Manual update:** Actions → *Update debarment snapshot* → *Run workflow*. Only repo collaborators can do this. The site has no trigger.
- **Connectivity check without publishing:** Actions → *Probe BGS connectivity* → *Run workflow*.
- **Red run:** open the run and read the `Retrieve official page` step.
  - `HTTP status 403`: BGS's firewall blocked the runner. Retry later. If it persists, BGS may have changed its policy, so don't work around it.
  - `No table with header…`, `refusing to guess` or `Data row … cells`: BGS changed the page layout. Update `scripts/extract.mjs`, add a fixture for the new layout to `tests/`, and run `npm test`.
  - `Final URL … differs`: the page moved. Confirm the new official URL before changing `SOURCE_URL`.
- **60-day rule:** GitHub disables scheduled workflows in a public repo after 60 days without repository activity. This workflow doesn't commit, so **check the Actions tab at least every ~45 days**, and push any commit or re-enable the workflow if needed. The site's red banner also shows when updates stop.

## Development

```bash
npm ci
npx playwright install chromium
npm test                                         # 40 tests, fixtures only, no requests to BGS
node scripts/fetch-debarment.mjs out/snapshot    # one live request to BGS
DIST_DIR=out/dist node scripts/build-site.mjs success out/snapshot
```

| Path | Purpose |
|---|---|
| `scripts/extract.mjs` | table identification and extraction (runs inside the browser) |
| `scripts/validate.mjs` | page gate, source URL, user agent |
| `scripts/fetch-debarment.mjs` | retrieval engine (navigation, extraction, PDF, metadata) |
| `scripts/build-site.mjs` | validation gate and Pages artifact; failure mode |
| `site/` | staff page (`index.html`, `app.js`, `lib.js`, `styles.css`); no framework, no external resources |
| `tests/` | `node:test` suites. Fixtures are test-only and never published. |
| `docs/` | feasibility/architecture report, plan, discovery evidence with checksums |

Dependencies: `playwright` 1.65.0 (exact, lockfile). Actions are pinned to commit SHAs.

## Privacy

The site has no cookies, analytics, external fonts or CDNs. Search runs only in the browser, and the CSP allows only same-origin requests. The PDF is an unmodified print of the public official page, so it includes the contacts BGS lists there.
