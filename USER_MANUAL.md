# Trustpilot 1M+ Page Scraper — User Manual

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Quick Start](#quick-start)
6. [CLI Reference](#cli-reference)
7. [Phase-by-Phase Workflow](#phase-by-phase-workflow)
8. [Proxy Setup](#proxy-setup)
9. [Email Extraction Tiers](#email-extraction-tiers)
10. [Third-Party Integrations](#third-party-integrations)
11. [Output Format](#output-format)
12. [Monitoring & Stats](#monitoring--stats)
13. [Resuming Interrupted Runs](#resuming-interrupted-runs)
14. [Troubleshooting](#troubleshooting)
15. [Architecture Overview](#architecture-overview)
16. [Cost Estimates](#cost-estimates)

---

## Overview

A production-grade Node.js pipeline that scrapes all Trustpilot business listings (~1M+ pages) and outputs a CSV with four columns:

```
trustpilot_url, domain, rating, email
```

The pipeline runs in five phases:

| Phase | Command | What it does |
|-------|---------|--------------|
| 1 | `discover` | Finds all Trustpilot business URLs from sitemaps + category tree |
| 2 | `scrape` | Fetches each page, extracts domain + rating |
| 3 | `emails` | Visits each business domain to find a contact email |
| 4 | `retry-captcha` | Re-processes captcha-blocked pages via Apify (optional) |
| 5 | `export` | Writes the final CSV |

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |
| Disk space | ≥ 10 GB (DB + logs + output) |
| Memory | ≥ 4 GB RAM recommended |

Optional external tools:
- **Rotating proxy provider** (highly recommended for 1M+ pages)
- **Apify account** — for captcha bypass and Tier 3 email enrichment
- **Firecrawl CLI** — for JS-rendered sites in Tier 2 email extraction

---

## Installation

```bash
git clone <repo>
cd "Trustpilot 1M+ Page Scraper"
npm install
cp .env.example .env
# Edit .env with your settings
```

---

## Configuration

All configuration lives in `.env`. Copy `.env.example` and fill in the values.

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `data/scraper.db` | SQLite database path. Override with `--db` flag. |
| `OUTPUT_DIR` | `output/` | Directory for CSV output |
| `CONCURRENCY` | `25` | Parallel workers for Trustpilot scraping |
| `EMAIL_CONCURRENCY` | `10` | Parallel workers for email extraction |
| `MAX_REQUESTS_PER_SECOND` | `10` | Starting request rate (auto-adjusts on 429/403) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### Proxy Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | — | Single rotating proxy URL (e.g. `http://user:pass@host:port`) |
| `PROXY_FILE` | `data/proxies.txt` | Path to file with one proxy URL per line |

### Timeout Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PAGE_TIMEOUT_MS` | `30000` | Per-request timeout for Trustpilot pages (ms) |
| `EMAIL_TIMEOUT_MS` | `15000` | Per-request timeout for business domains (ms) |
| `MAX_RETRIES` | `3` | Max retry attempts per URL (exponential backoff: 1s, 2s, 4s) |

### Third-Party API Keys

| Variable | Description |
|----------|-------------|
| `APIFY_TOKEN` | From https://console.apify.com/account/integrations |
| `FIRECRAWL_API_KEY` | From https://www.firecrawl.dev/ (only needed if using Firecrawl Tier 2) |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_EMAIL_PHASE` | `false` | Set `true` to skip email extraction entirely |
| `USE_FIRECRAWL_EMAILS` | `false` | Enable Tier 2 Firecrawl email extraction |
| `USE_APIFY_FALLBACK` | `false` | Enable Apify captcha bypass |
| `USE_APIFY_EMAILS` | `false` | Enable Tier 3 Apify email enrichment |

**envBool** accepts: `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` (case-insensitive).

---

## Quick Start

### Minimal run (no proxies, no email, test mode)

```bash
# Discover URLs from sitemaps
npx tsx src/index.ts discover

# Scrape 50 pages to verify setup
npx tsx src/index.ts scrape --limit 50 --verbose

# Export to CSV
npx tsx src/index.ts export --output output/test.csv
```

### Full production run

```bash
# Phase 1: Discover all ~1M URLs
npx tsx src/index.ts discover --categories

# Phase 2: Scrape all pages (run continuously, resumable)
npx tsx src/index.ts scrape --concurrency 25

# Phase 3: Extract emails
npx tsx src/index.ts emails --tier 1

# Phase 4: Retry captcha-blocked pages
npx tsx src/index.ts retry-captcha --apify

# Phase 5: Export
npx tsx src/index.ts export --output output/results.csv
```

### One-command full pipeline

```bash
npx tsx src/index.ts run \
  --concurrency 25 \
  --apify \
  --firecrawl \
  --verbose
```

---

## CLI Reference

All commands support `--verbose` for debug-level logging. The `--db` flag overrides the database path for any command.

---

### `discover`

Finds all Trustpilot business listing URLs and stores them in the database.

```
npx tsx src/index.ts discover [options]
```

| Flag | Description |
|------|-------------|
| `--categories` | Also crawl the category tree (slower but catches more URLs) |
| `--apify` | Also run Apify keyword-based search discovery |
| `--verbose` | Debug logging |

**Sources used:**
1. **Sitemaps** (primary) — parses `robots.txt` to find the sitemap index, then processes all review sitemaps. Handles `.gz` sitemaps correctly. Accepts both `www.trustpilot.com` and locale-prefixed variants (`uk.trustpilot.com`, `/de/review/…`).
2. **Category tree** — crawls `trustpilot.com/categories` recursively (depth ≤ 4), following subcategories and pagination. Rate-limited to 0.5 req/s.
3. **Apify search** (optional) — runs keyword searches via `zerobreak~trustpilot-search-scraper` actor across 24 industry verticals.

---

### `scrape`

Scrapes Trustpilot business pages and extracts `domain` + `rating` for each.

```
npx tsx src/index.ts scrape [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--concurrency <n>` | `25` | Parallel worker count |
| `--limit <n>` | — | Stop after N pages (useful for testing) |
| `--db <path>` | env `DB_PATH` | SQLite database path |
| `--proxy-file <path>` | env `PROXY_FILE` | Proxy list file |
| `--verbose` | — | Debug logging |

**Domain extraction priority:**
1. JSON-LD `Organization.url`
2. Microdata `schema.org/Organization`
3. CSS selectors (anchor tags, aria-labels)
4. URL slug fallback

**Rate limiting:** Starts at `MAX_REQUESTS_PER_SECOND`. Automatically halves on 429, reduces 25% on 403, and gradually recovers on success. Proxy quarantine activates after 5 bans within 10 minutes (30-minute timeout).

**Captcha handling:**
- Cloudflare challenge pages → marked `captcha` (retried via Apify)
- Deleted business profiles (small 403 body, no CF markers) → marked `failed`
- Generic blocks → retry with exponential backoff

**Resumable:** Safe to stop with `Ctrl+C`. All in-progress rows are released back to `pending`. Restart the command and it continues from where it left off.

---

### `emails`

Extracts contact emails from business domains using a three-tier strategy.

```
npx tsx src/index.ts emails [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--tier <n>` | all | Run only tier 1, 2, or 3 |
| `--limit <n>` | — | Max domains to process |
| `--concurrency <n>` | `10` | Tier 1 parallel workers |
| `--firecrawl` | — | Enable Tier 2 (requires `firecrawl` CLI installed) |
| `--apify` | — | Enable Tier 3 (requires `APIFY_TOKEN`) |
| `--verbose` | — | Debug logging |

See [Email Extraction Tiers](#email-extraction-tiers) for full details.

---

### `export`

Exports the final deduplicated CSV.

```
npx tsx src/index.ts export [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output <path>` | `output/trustpilot_results.csv` | Output file path |
| `--verbose` | — | Debug logging |

Runs data quality checks before export and logs:
- Rows with NULL domain (excluded)
- Rows with invalid ratings
- Duplicate domains (only the latest row per domain is exported)
- Invalid email formats

The export is streamed row-by-row and will not OOM even on 1M+ rows. The file is UTF-8 BOM-encoded for Excel compatibility.

---

### `retry-captcha`

Re-processes URLs that were blocked with a captcha challenge.

```
npx tsx src/index.ts retry-captcha [options]
```

| Flag | Description |
|------|-------------|
| `--apify` | Use Apify residential proxies (preferred, bypasses most challenges) |
| `--concurrency <n>` | Worker concurrency when self-retrying (default: 5) |

Without `--apify`, retries with the scraper itself at 1 req/s.

---

### `retry-failed`

Resets all `failed` URLs back to `pending` for another scrape attempt.

```
npx tsx src/index.ts retry-failed
```

---

### `stats`

Shows a progress dashboard.

```
npx tsx src/index.ts stats [--email]
```

| Flag | Description |
|------|-------------|
| `--email` | Also show email extraction breakdown by tier |

---

### `run`

Runs the full pipeline end-to-end.

```
npx tsx src/index.ts run [options]
```

| Flag | Description |
|------|-------------|
| `--concurrency <n>` | Scrape worker concurrency |
| `--limit <n>` | Limit URLs per phase (for testing) |
| `--apify` | Enable Apify (discovery + captcha retry + Tier 3 emails) |
| `--firecrawl` | Enable Firecrawl Tier 2 emails |
| `--skip-email` | Skip Phase 3 entirely |
| `--verbose` | Debug logging |

---

## Phase-by-Phase Workflow

### Phase 1 — Discovery (1–2 hours)

```bash
npx tsx src/index.ts discover --categories
```

Expected result: `~1,000,000` rows inserted into `urls` table with status `pending`.

Check progress:
```bash
npx tsx src/index.ts stats
```

### Phase 2 — Scraping (24–72 hours depending on concurrency + proxies)

```bash
npx tsx src/index.ts scrape --concurrency 25
```

The scraper is fully resumable. You can stop and restart at any time.

Typical throughput: ~1–5 pages/second (10–25 req/s with rate-limit adaptation).

Monitor progress in another terminal:
```bash
watch -n 60 "npx tsx src/index.ts stats"
```

At 1M pages with 5 pages/s: ~55 hours. Scale `CONCURRENCY` and proxy pool for faster throughput.

### Phase 3 — Email Extraction

**Tier 1 (self-hosted, free):**
```bash
npx tsx src/index.ts emails --tier 1 --concurrency 10
```
Visits homepage + 6 contact paths per domain. 60-second timeout per domain. Decodes HTML-obfuscated emails (`&#64;`, `[at]`, etc.).

**Tier 2 (Firecrawl, paid per page):**
```bash
npx tsx src/index.ts emails --tier 2 --firecrawl
```
Only runs on domains that failed Tier 1. Uses Firecrawl CLI to render JS-heavy pages.

**Tier 3 (Apify batch, paid per run):**
```bash
npx tsx src/index.ts emails --tier 3 --apify
```
Batch-enriches remaining domains via `vdrmota/contact-info-scraper` Apify actor.

### Phase 4 — Captcha Retry (optional)

```bash
npx tsx src/index.ts stats
# Check "Scrape captcha" count

npx tsx src/index.ts retry-captcha --apify
```

### Phase 5 — Export

```bash
npx tsx src/index.ts export --output output/trustpilot_$(date +%Y%m%d).csv
```

---

## Proxy Setup

Running without proxies works for small-scale testing but will quickly result in IP bans at scale. At 1M+ pages, **rotating residential proxies are required**.

### File-based proxy list

Create `data/proxies.txt`:
```
http://user:pass@proxy1.host:8080
http://user:pass@proxy2.host:8080
socks5://user:pass@proxy3.host:1080
```

Then:
```bash
npx tsx src/index.ts scrape --proxy-file data/proxies.txt
```

### Single rotating proxy URL

```env
PROXY_URL=http://user:pass@rotating.proxy.io:8080
```

### Proxy behaviour

- Proxies are assigned round-robin to workers
- On timeout/ECONNRESET/ECONNREFUSED: proxy is reported as banned
- After 5 bans within 10 minutes: proxy is quarantined for 30 minutes
- Quarantine state persists to `data/proxy-quarantine.json` across restarts
- 429 (rate limit) does **not** ban the proxy — only the rate limiter backs off
- If all proxies are quarantined: requests fall back to direct (your server IP)

---

## Email Extraction Tiers

### Tier 1 — Direct HTTP (free, ~60% hit rate)

For each domain:
1. Tries `https://domain.com` then `http://domain.com`
2. Parses JSON-LD `Organization.email`, `mailto:` links, regex on page text
3. Decodes obfuscated emails (`&#64;`, `[at]`, `(at)`, ` AT `, `[dot]`)
4. If homepage returns non-2xx, still tries 6 contact paths
5. Hard 60-second timeout per domain

Email filtering rules:
- Drops `noreply@`, `no-reply@`, `donotreply@`
- Drops emails from blocked domains (`sentry.io`, `cloudflare.com`, `example.com`, etc.)
- Only accepts emails matching the business domain or its subdomains
- Gmail/Outlook/etc. accepted only as a last resort (no business-domain email found)

Ranking: `info@` > `contact@` > `hello@` > `support@` > `admin@` > `sales@` > others

### Tier 2 — Firecrawl (requires Firecrawl CLI, paid)

Runs on all Tier 1 failures. Firecrawl renders JavaScript so emails hidden behind React/Vue/Angular frontends are found. Tries homepage + `/contact` + `/contact-us` + `/about`.

Install Firecrawl CLI:
```bash
npm install -g firecrawl-cli
firecrawl auth  # enter your API key
```

### Tier 3 — Apify Batch (requires APIFY_TOKEN, paid)

Runs `vdrmota/contact-info-scraper` actor on all remaining domains. Processes in one batch call. Results are paginated (no 1000-item truncation). Timeout: 30 minutes per batch.

### Email status values in the database

| `email_status` | Meaning |
|----------------|---------|
| `pending` | Not yet processed |
| `done_tier1` | Email found via Tier 1 |
| `done_tier2` | Email found via Tier 2 (Firecrawl) |
| `done_tier3` | Email found via Tier 3 (Apify) |
| `not_found_tier1` | Tier 1 found nothing — eligible for Tier 2 |
| `not_found_tier2` | Tier 2 found nothing — eligible for Tier 3 |
| `not_found_tier3` | All tiers exhausted |
| `failed` | Network/DNS error, not retried |

---

## Third-Party Integrations

### Apify

Used for three purposes:

1. **Discovery** (`discover --apify`): Keyword-based Trustpilot search across 24 verticals, ~24,000 additional URLs.

2. **Captcha bypass** (`retry-captcha --apify`): Sends captcha-blocked URLs to `casper11515/trustpilot-reviews-scraper` with residential proxies. Recovers ~80% of blocked pages.

3. **Email enrichment** (`emails --tier 3`): Batch contact-info extraction via `vdrmota/contact-info-scraper`.

All Apify calls use `actor.start()` + poll loop + `actor.abort()` on timeout (30 min default). Dataset reads are paginated in 1000-item pages.

### Firecrawl

Used for Tier 2 email extraction only. Called via `firecrawl` CLI (must be installed and authenticated). Each call is sandboxed in a temp directory; output is cleaned up after extraction. Shell injection is prevented by using `spawnSync` (no shell expansion).

---

## Output Format

The final CSV has four columns:

```csv
trustpilot_url,domain,rating,email
https://www.trustpilot.com/review/acme.com,acme.com,4.2,info@acme.com
https://www.trustpilot.com/review/beta-corp.com,beta-corp.com,3.7,
```

- **trustpilot_url**: Full Trustpilot listing URL
- **domain**: Business domain (e.g. `acme.com`)
- **rating**: Float 1.0–5.0, empty if unknown
- **email**: Best contact email found, empty if none
- File is UTF-8 BOM encoded (Excel-safe)
- One row per unique domain (latest scraped row wins on duplicates)

---

## Monitoring & Stats

### Progress dashboard

```bash
npx tsx src/index.ts stats --email
```

Output:
```
=== Trustpilot Scraper Stats ===
URLs discovered:    1,023,412
Scrape pending:       820,301
Scrape done:          185,000
Scrape failed:          3,411
Scrape captcha:           700
Success rate:          18.1%

── Email Coverage ──
Total with email:    112,500 (60.8%)
  Tier 1 (direct):  98,000
  Tier 2 Firecrawl: 10,000
  Tier 3 Apify:      4,500
Not found Tier 1:    44,200
Not found Tier 2:    12,000
Not found Tier 3:     4,300
Pending:             12,000
```

### Logs

Logs are written to:
- **stdout** (pretty-printed if TTY, JSON otherwise)
- **`logs/scraper.log`** (rotating: daily rollover, max 50 MB, 7 files retained)

To follow live:
```bash
tail -f logs/scraper.log | npx pino-pretty
```

### SQLite inspection

```bash
sqlite3 data/scraper.db

-- Scrape progress
SELECT status, COUNT(*) FROM urls GROUP BY status;

-- Email coverage
SELECT email_status, COUNT(*) FROM results GROUP BY email_status;

-- Top 10 highest-rated businesses with email
SELECT domain, rating, email FROM results
WHERE email IS NOT NULL ORDER BY rating DESC LIMIT 10;

-- Failed URLs to investigate
SELECT trustpilot_url, attempts FROM urls WHERE status='failed' LIMIT 20;
```

---

## Resuming Interrupted Runs

The pipeline is fully resumable at every phase:

- **SIGINT (Ctrl+C)** during scrape: all in-progress rows are released back to `pending` automatically before exit.
- **Hard kill / crash**: on next startup, `resetStaleScraping()` is called automatically, resetting rows that have been in `scraping` status for more than 1 hour.
- **Re-run any command**: it picks up from where it left off (skips `done` rows).
- **Multiple concurrent scrapers**: safe to run `scrape` in parallel on the same DB — `RETURNING *` in the claim query prevents double-scraping.

---

## Troubleshooting

### "No URLs discovered"

- Check that `robots.txt` is accessible: `curl https://www.trustpilot.com/robots.txt`
- Sitemap fetches go direct (no proxy, no rate limit) — check your network can reach Trustpilot.
- Try `--verbose` and look for sitemap fetch errors.

### High captcha rate (>5%)

- Add or rotate proxies
- Lower `CONCURRENCY` and `MAX_REQUESTS_PER_SECOND`
- Run `retry-captcha --apify` to recover blocked pages

### Email hit rate is low (<40%)

- Many domains have no public email — 40–60% is typical
- Run Tier 2 (Firecrawl) for JS-heavy sites
- Run Tier 3 (Apify) for remaining gaps
- Check `logs/scraper.log` for patterns in `not_found_tier1`

### "All proxies quarantined"

- Requests fall back to direct IP temporarily
- Increase proxy pool size
- Lower rate: `MAX_REQUESTS_PER_SECOND=3`
- Quarantine clears automatically after 30 minutes
- Delete `data/proxy-quarantine.json` to force-clear all quarantines

### DB locked / "busy_timeout" errors

- Normal under high concurrency — `busy_timeout=5000` retries for 5 s before failing
- If persisting, reduce `CONCURRENCY`
- Ensure only one `discover` process runs at a time

### CSV export hangs / incomplete

- Check disk space: `df -h .`
- The export streams rows — may take several minutes for 1M rows
- Monitor growth: `ls -lh output/`

### "APIFY_TOKEN not set"

```env
APIFY_TOKEN=apify_api_xxxxxxxxxxxxx
```

---

## Architecture Overview

```
src/
├── index.ts              — CLI entry point (commander)
├── config.ts             — Lazy env-var config (getters, read at first use)
│
├── discovery/
│   ├── sitemap.ts        — Sitemap index + child sitemap parsing (gz-safe)
│   ├── category-crawl.ts — Category tree crawl with depth limit + visited set
│   ├── url-store.ts      — SQLite UrlStore (RETURNING * claim, lazy stmts)
│   └── apify-discovery.ts — Keyword-based Apify gap-fill
│
├── scraper/
│   ├── request.ts        — fetchPage/fetchDirect/fetchPageBuffer, ProxyAgent pool
│   ├── trustpilot.ts     — JSON-LD → microdata → CSS → slug domain extraction
│   ├── worker-pool.ts    — p-queue workers, SIGINT release, processed++ on all paths
│   ├── email-finder.ts   — Tier 1: HTTP email scraper (60s timeout, entity decode)
│   ├── email-worker.ts   — Tier 1/2/3 orchestration (iterate() streaming, backpressure)
│   ├── firecrawl-email.ts — Tier 2: spawnSync Firecrawl (no shell injection)
│   └── apify-email.ts    — Tier 3: Apify batch (start+poll+abort, paginated)
│
├── anti-bot/
│   ├── rate-limiter.ts   — Token-slot throttle (nextSlotAt, concurrent-safe)
│   ├── proxy-manager.ts  — Map-based O(1) proxy pool, quarantine persistence
│   ├── captcha-handler.ts — CF markers, multilingual, deleted-profile distinction
│   ├── fingerprint.ts    — Browser-consistent header bundles per UA family
│   └── apify-fallback.ts — Captcha bypass (start+poll+abort, batch inserts)
│
├── storage/
│   ├── db.ts             — SQLite init (WAL, busy_timeout, FK, 1h stale TTL)
│   ├── models.ts         — TypeScript interfaces + email_status union
│   └── csv-export.ts     — Streaming export (correlated subquery, pipeline())
│
└── utils/
    ├── logger.ts         — Lazy pino proxy + pino-roll rotation
    ├── retry.ts          — withRetry (isRetryable, HttpError, base-2 backoff)
    └── validators.ts     — Entity decode, filterEmails, normalizeDomain, slugFromUrl
```

### Database schema

```sql
urls (id, slug UNIQUE, trustpilot_url, status, attempts, created_at, updated_at)
     status: pending | scraping | done | failed | captcha

results (id, slug UNIQUE→urls, trustpilot_url, domain, rating, email,
         email_status, domain_source, scraped_at)
     email_status: pending | done_tier1 | done_tier2 | done_tier3 |
                   not_found_tier1 | not_found_tier2 | not_found_tier3 | failed
```

---

## Cost Estimates

For a full 1M-page run (indicative, varies by provider):

| Component | Estimated Cost |
|-----------|---------------|
| Residential proxies (1M pages × 50–100 KB avg) | $50–$150 |
| Apify captcha bypass (~50k URLs at $0.001/run) | $5–$50 |
| Firecrawl Tier 2 (~100k domains) | $10–$50 |
| Apify Tier 3 email (~100k domains) | $5–$20 |
| **Total** | **~$70–$270** |

Running without Apify/Firecrawl and on datacenter proxies can reduce cost to <$50, at the expense of a lower email hit rate and higher captcha rate.
