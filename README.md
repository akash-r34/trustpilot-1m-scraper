# Trustpilot 1M+ Page Scraper

A production-grade Node.js/TypeScript pipeline that discovers and scrapes every Trustpilot business listing (~1M+ pages), extracts contact emails from each domain, and outputs a clean CSV.

```
trustpilot_url, domain, rating, email
```

**Designed for unattended, multi-day runs.** Fully resumable, streaming (no OOM at 1M rows), concurrent-process-safe, and hardened against rate limits, captchas, and proxy failures.

---

## Features

- **Five-phase pipeline** — discover → scrape → emails → retry-captcha → export
- **~1M URL discovery** via sitemaps (gz-safe), category tree crawl, and optional Apify gap-fill
- **Three-tier email extraction** — direct HTTP → Firecrawl (JS rendering) → Apify batch
- **Resumable at every phase** — SIGINT releases claimed rows; stale rows auto-reset on restart
- **Concurrent-process-safe** — `RETURNING *` claim prevents cross-process double-scraping
- **Anti-bot stack** — rotating proxies, token-slot rate limiter, Cloudflare detection, browser-consistent header bundles, quarantine persistence
- **robots.txt compliance** — fetched at startup, Disallow rules logged; opt-in enforcement via `RESPECT_ROBOTS=true`
- **Streaming export** — correlated subquery + `iterate()` cursor, never OOMs on 1M rows
- **71 unit tests** across all critical paths

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Configuration](#configuration)
- [Pipeline Phases](#pipeline-phases)
- [Email Extraction Tiers](#email-extraction-tiers)
- [Proxy Setup](#proxy-setup)
- [Output Format](#output-format)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Cost Estimates](#cost-estimates)

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |
| Disk space | ≥ 10 GB |
| RAM | ≥ 4 GB recommended |

Optional:
- Rotating residential proxy provider (required for 1M+ scale)
- [Apify](https://apify.com) account — captcha bypass + Tier 3 email enrichment
- [Firecrawl CLI](https://www.firecrawl.dev) — JS-rendered sites in Tier 2 email extraction

---

## Installation

```bash
git clone https://github.com/akash-r34/trustpilot-1m-scraper.git
cd trustpilot-1m-scraper
npm install
cp .env.example .env
# Edit .env with your settings
```

---

## Quick Start

### Test run (no proxies, 50 pages)

```bash
npx tsx src/index.ts discover
npx tsx src/index.ts scrape --limit 50 --verbose
npx tsx src/index.ts export --output output/test.csv
```

### Full production run

```bash
# Phase 1: Discover all ~1M URLs (1–2 hours)
npx tsx src/index.ts discover --categories

# Phase 2: Scrape all pages (24–72 hours)
npx tsx src/index.ts scrape --concurrency 25

# Phase 3: Extract emails
npx tsx src/index.ts emails --tier 1

# Phase 4: Recover captcha-blocked pages (optional)
npx tsx src/index.ts retry-captcha --apify

# Phase 5: Export CSV
npx tsx src/index.ts export --output output/results.csv
```

### One-command pipeline

```bash
npx tsx src/index.ts run --concurrency 25 --apify --firecrawl --verbose
```

---

## CLI Reference

All commands accept `--verbose` (debug logging) and `--db <path>` (override database path).

### `discover`

Finds all Trustpilot business listing URLs and stores them in the database.

```
npx tsx src/index.ts discover [--categories] [--apify] [--verbose]
```

| Flag | Description |
|------|-------------|
| `--categories` | Crawl the category tree (slower, catches additional URLs) |
| `--apify` | Run Apify keyword-based search across 24 industry verticals |

**Sources:** Sitemap index (from `robots.txt` → `.gz`-aware parsing) · Category tree (depth ≤ 4, 0.5 req/s) · Apify keyword search (optional)

### `scrape`

Fetches each Trustpilot page and extracts `domain` + `rating`.

```
npx tsx src/index.ts scrape [--concurrency <n>] [--limit <n>] [--proxy-file <path>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--concurrency <n>` | `25` | Parallel workers |
| `--limit <n>` | — | Stop after N pages |
| `--proxy-file <path>` | env `PROXY_FILE` | Proxy list file |

Domain extraction priority: JSON-LD `Organization.url` → microdata → CSS selectors → slug fallback.  
Captcha-blocked pages are marked `captcha` and retried via Phase 4. Deleted profiles are marked `failed`.  
**Resumable:** `Ctrl+C` releases in-progress rows back to `pending`.

### `emails`

Extracts contact emails from business domains using a three-tier strategy.

```
npx tsx src/index.ts emails [--tier <1|2|3>] [--limit <n>] [--concurrency <n>] [--firecrawl] [--apify]
```

| Flag | Description |
|------|-------------|
| `--tier <n>` | Run only one tier |
| `--firecrawl` | Enable Tier 2 (JS-rendered pages via Firecrawl) |
| `--apify` | Enable Tier 3 (Apify batch enrichment) |

### `export`

Exports the final deduplicated CSV. Streams row-by-row; safe at any scale.

```
npx tsx src/index.ts export [--output <path>]
```

Runs data-quality checks (null domains, invalid ratings, duplicate domains) and exports one row per unique domain (latest scraped wins). UTF-8 BOM encoded for Excel compatibility.

### `retry-captcha`

Re-processes Cloudflare-blocked pages.

```
npx tsx src/index.ts retry-captcha [--apify] [--concurrency <n>]
```

With `--apify`: sends URLs to Apify residential proxies (bypasses ~80% of challenges).  
Without: retries with the scraper at 1 req/s.

### `retry-failed`

Resets all `failed` URLs back to `pending`.

```
npx tsx src/index.ts retry-failed
```

### `stats`

Shows the progress dashboard.

```
npx tsx src/index.ts stats [--email]
```

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
  Tier 1 (direct):   98,000
  Tier 2 Firecrawl:  10,000
  Tier 3 Apify:       4,500
Not found Tier 1:    44,200
...
```

### `run`

Full pipeline end-to-end.

```
npx tsx src/index.ts run [--concurrency <n>] [--limit <n>] [--apify] [--firecrawl] [--skip-email]
```

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All values can also be overridden via CLI flags.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `data/scraper.db` | SQLite database path |
| `OUTPUT_DIR` | `output/` | CSV output directory |
| `CONCURRENCY` | `25` | Scrape worker count |
| `EMAIL_CONCURRENCY` | `10` | Email worker count |
| `MAX_REQUESTS_PER_SECOND` | `10` | Starting rate (auto-adjusts on 429) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### Timeouts & Retries

| Variable | Default | Description |
|----------|---------|-------------|
| `PAGE_TIMEOUT_MS` | `30000` | Per-request timeout for Trustpilot pages |
| `EMAIL_TIMEOUT_MS` | `15000` | Per-request timeout for business domains |
| `MAX_RETRIES` | `3` | Max retries per URL (backoff: 1s → 2s → 4s) |

### API Keys

| Variable | Description |
|----------|-------------|
| `APIFY_TOKEN` | [console.apify.com/account/integrations](https://console.apify.com/account/integrations) |
| `FIRECRAWL_API_KEY` | [firecrawl.dev](https://www.firecrawl.dev/) |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_EMAIL_PHASE` | `false` | Skip Phase 3 entirely |
| `USE_FIRECRAWL_EMAILS` | `false` | Auto-enable Tier 2 emails |
| `USE_APIFY_FALLBACK` | `false` | Auto-enable Apify captcha bypass |
| `USE_APIFY_EMAILS` | `false` | Auto-enable Tier 3 email enrichment |
| `RESPECT_ROBOTS` | `false` | Enforce `robots.txt` Disallow rules at URL insert time |

> **`envBool`** accepts `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` (case-insensitive).

---

## Pipeline Phases

### Phase 1 — Discovery (1–2 hours)

Parses Trustpilot's sitemap index (discovered via `robots.txt`), processes all `review`/`business`/`companies` child sitemaps (`.gz`-aware), optionally crawls the category tree and runs Apify keyword searches.

Expected result: ~1,000,000 `pending` rows in the `urls` table.

### Phase 2 — Scraping (24–72 hours)

Workers claim batches of URLs atomically (`UPDATE … RETURNING *`), scrape each page, and write `domain` + `rating` to the `results` table. Rate limiter uses a token-slot algorithm so concurrent workers don't burst simultaneously. Proxies are managed with O(1) lookup, round-robin assignment, and quarantine persistence.

Typical throughput: 1–5 pages/second with a healthy proxy pool.

Monitor live:
```bash
watch -n 60 "npx tsx src/index.ts stats"
```

### Phase 3 — Email Extraction

See [Email Extraction Tiers](#email-extraction-tiers).

### Phase 4 — Captcha Retry (optional)

```bash
npx tsx src/index.ts retry-captcha --apify
```

Recovers ~80% of Cloudflare-blocked pages using Apify residential proxies.

### Phase 5 — Export

Streams all results through a correlated subquery (picks the latest row per domain), validates, and writes a UTF-8 BOM CSV.

---

## Email Extraction Tiers

### Tier 1 — Direct HTTP (~60% hit rate, free)

For each domain, tries `https://` then `http://`, visits the homepage and up to 6 contact paths (`/contact`, `/contact-us`, `/about`, `/about-us`, `/team`, `/impressum`). Hard 60-second cap per domain.

Decodes obfuscated emails: `&#64;` · `[at]` · `(at)` · ` AT ` · `[dot]` · `&#46;`

Email filtering:
- Drops `noreply@`, `no-reply@`, blocked infrastructure domains
- Prefers emails matching the business domain; accepts freemail only as a last resort
- Ranking: `info@` > `contact@` > `hello@` > `support@` > others

### Tier 2 — Firecrawl (paid, JS-rendered sites)

Runs only on Tier 1 failures. Uses `firecrawl` CLI to fully render JavaScript-heavy pages before extraction.

```bash
npm install -g firecrawl-cli && firecrawl auth
npx tsx src/index.ts emails --tier 2 --firecrawl
```

### Tier 3 — Apify Batch (paid, bulk enrichment)

Sends all remaining domains to `vdrmota/contact-info-scraper` in one batch. Results are paginated (no 1000-item truncation). 30-minute timeout.

```bash
npx tsx src/index.ts emails --tier 3 --apify
```

### Email status values

| Status | Meaning |
|--------|---------|
| `pending` | Not yet processed |
| `done_tier1` | Found via Tier 1 |
| `done_tier2` | Found via Firecrawl |
| `done_tier3` | Found via Apify |
| `not_found_tier1` | Tier 1 found nothing |
| `not_found_tier2` | Tier 2 found nothing |
| `not_found_tier3` | All tiers exhausted |
| `failed` | Network/DNS error |

---

## Proxy Setup

Running without proxies works for small-scale testing. For 1M+ pages, rotating residential proxies are required.

### File-based list

```
# data/proxies.txt
http://user:pass@proxy1.host:8080
http://user:pass@proxy2.host:8080
socks5://user:pass@proxy3.host:1080
```

```bash
npx tsx src/index.ts scrape --proxy-file data/proxies.txt
```

### Single rotating proxy

```env
PROXY_URL=http://user:pass@rotating.proxy.io:8080
```

### Proxy behaviour

- Round-robin assignment to workers; `ProxyAgent` instances reused (no FD leaks)
- Timeout / `ECONNRESET` / `ECONNREFUSED` / `AbortError` → proxy reported as banned
- 5 bans within 10 minutes → 30-minute quarantine
- Quarantine state persists to `data/proxy-quarantine.json` across restarts
- **429 does not ban the proxy** — only the rate limiter backs off
- All proxies quarantined → falls back to direct IP temporarily

---

## Output Format

```csv
trustpilot_url,domain,rating,email
https://www.trustpilot.com/review/acme.com,acme.com,4.2,info@acme.com
https://www.trustpilot.com/review/beta-corp.com,beta-corp.com,3.7,
```

- One row per unique domain (latest scraped row wins on duplicates)
- `rating` is a float 1.0–5.0, blank if unknown
- `email` is blank if none found after all tiers
- UTF-8 BOM encoded for direct Excel/Google Sheets import

---

## Monitoring

### Live stats

```bash
npx tsx src/index.ts stats --email
watch -n 60 "npx tsx src/index.ts stats"
```

### Logs

- **stdout** — pretty-printed on TTY, JSON in production
- **`logs/scraper.log`** — daily rotation, 50 MB max per file, 7 files retained

```bash
tail -f logs/scraper.log | npx pino-pretty
```

### SQLite direct queries

```bash
sqlite3 data/scraper.db

-- Scrape progress
SELECT status, COUNT(*) FROM urls GROUP BY status;

-- Email coverage by tier
SELECT email_status, COUNT(*) FROM results GROUP BY email_status;

-- Top-rated businesses with email
SELECT domain, rating, email FROM results
WHERE email IS NOT NULL ORDER BY rating DESC LIMIT 20;

-- Identify failed URLs
SELECT trustpilot_url, attempts FROM urls WHERE status='failed' LIMIT 20;
```

---

## Troubleshooting

**No URLs discovered**
- Check network: `curl https://www.trustpilot.com/robots.txt`
- Sitemap fetches are direct (no proxy) — verify connectivity
- Run with `--verbose` and inspect logs

**High captcha rate (>5%)**
- Add or rotate proxies; lower `CONCURRENCY` and `MAX_REQUESTS_PER_SECOND`
- Run `retry-captcha --apify` to recover blocked pages

**Low email hit rate (<40%)**
- Normal — many businesses have no public email
- Run Tier 2 (Firecrawl) for JS-heavy sites
- Run Tier 3 (Apify) for remaining gaps

**All proxies quarantined**
- Requests fall back to direct IP; quarantine clears after 30 minutes
- Force-clear: `rm data/proxy-quarantine.json`
- Lower rate: `MAX_REQUESTS_PER_SECOND=3`

**DB locked errors**
- `busy_timeout=5000` retries automatically; usually transient
- Ensure only one `discover` process runs at a time
- Reduce `CONCURRENCY` if persisting

**CSV export is slow**
- Normal — streaming 1M rows takes a few minutes
- Check disk space: `df -h .`

---

## Architecture

```
src/
├── index.ts              CLI entry point (commander)
├── config.ts             Lazy env-var config (getters, read at first use)
│
├── discovery/
│   ├── sitemap.ts        Sitemap index + child parsing (.gz-safe, fetchDirect)
│   ├── category-crawl.ts Category tree (depth≤4, visited Set, rate-limited)
│   ├── url-store.ts      UrlStore — RETURNING * claim, lazy prepared stmts
│   └── apify-discovery.ts Keyword-based Apify gap-fill
│
├── scraper/
│   ├── request.ts        fetchPage / fetchDirect / fetchPageBuffer, ProxyAgent pool
│   ├── trustpilot.ts     JSON-LD → microdata → CSS domain/rating extraction
│   ├── worker-pool.ts    p-queue workers, SIGINT release, processed++ all paths
│   ├── email-finder.ts   Tier 1: HTTP (60s cap, entity decode, contact paths)
│   ├── email-worker.ts   Tier 1/2/3 orchestration (iterate() + backpressure)
│   ├── firecrawl-email.ts Tier 2: spawnSync Firecrawl (no shell injection)
│   └── apify-email.ts    Tier 3: start+poll+abort, paginated listItems
│
├── anti-bot/
│   ├── rate-limiter.ts   nextSlotAt token-slot (concurrent-safe), LRU domain buckets
│   ├── proxy-manager.ts  Map-based O(1) pool, quarantine persistence
│   ├── captcha-handler.ts CF markers, multilingual, deleted-profile detection
│   ├── fingerprint.ts    Browser-consistent header bundles per UA family
│   ├── robots.ts         robots.txt fetch, Disallow parser, startup compliance log
│   └── apify-fallback.ts Captcha bypass (start+poll+abort, 200-row batch inserts)
│
├── storage/
│   ├── db.ts             SQLite init (WAL, busy_timeout=5000, FK, 1h stale TTL)
│   ├── models.ts         TypeScript interfaces + email_status union
│   └── csv-export.ts     Streaming export (correlated subquery, pipeline())
│
└── utils/
    ├── logger.ts         Lazy pino Proxy + pino-roll daily rotation
    ├── retry.ts          withRetry (isRetryable, HttpError, base-2 backoff)
    └── validators.ts     Entity decode, filterEmails, slugFromUrl
```

### Database schema

```sql
urls    (id, slug UNIQUE, trustpilot_url, status, attempts, created_at, updated_at)
        status: pending | scraping | done | failed | captcha

results (id, slug UNIQUE → urls(slug) ON DELETE CASCADE,
         trustpilot_url, domain, rating, email,
         email_status, domain_source, scraped_at)
        email_status: pending | done_tier1 | done_tier2 | done_tier3 |
                      not_found_tier1 | not_found_tier2 | not_found_tier3 | failed
```

### Key design decisions

| Decision | Reason |
|----------|--------|
| Config uses JS getters, not a frozen object | CLI flags mutate `process.env` before any module reads config |
| Logger is a `Proxy` | `--verbose` flag must take effect before `pino` reads the log level |
| `UPDATE … RETURNING *` for batch claiming | Returns only the rows just claimed, preventing cross-process double-scraping |
| `nextSlotAt` instead of `lastRequest` | All 25 concurrent workers reading the same scalar fired simultaneously — token-slot serialises them |
| `spawnSync` instead of `execSync` for Firecrawl | `execSync` with template strings is a shell injection vector |
| `actor.start()` + poll instead of `actor.call()` | `.call()` has no timeout and hangs indefinitely on stuck runs |
| `stmt.iterate()` for exports and email workers | `.all()` on 1M rows materialises everything in memory → OOM |

---

## Cost Estimates

For a complete 1M-page run:

| Component | Estimated Cost |
|-----------|---------------|
| Residential proxies (1M pages, ~75 KB avg) | $50–$150 |
| Apify captcha bypass (~50k URLs) | $5–$50 |
| Firecrawl Tier 2 (~100k domains) | $10–$50 |
| Apify Tier 3 email (~100k domains) | $5–$20 |
| **Total** | **~$70–$270** |

Running on datacenter proxies only, skipping Apify/Firecrawl, can bring the cost below $50 at the expense of a higher captcha rate and lower email coverage.

---

## Testing

```bash
npm test           # run all 71 tests
npx vitest run     # same, explicit
```

Test coverage: scraping logic, rate-limiter concurrency, RETURNING * disjoint batch claiming, CSV correlated subquery, email entity decoding, captcha classification, robots.txt parsing.
