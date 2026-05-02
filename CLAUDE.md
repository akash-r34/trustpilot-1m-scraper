# CLAUDE.md — Trustpilot 1M+ Page Scraper

## What this project is

A production-grade Node.js/TypeScript pipeline that:
1. Discovers ~1M+ Trustpilot business listing URLs (sitemaps + category tree + Apify)
2. Scrapes each page to extract `domain` and `rating`
3. Visits each business domain to find a contact `email`
4. Exports everything as a CSV: `trustpilot_url, domain, rating, email`

Budget target: complete full pipeline for < $50 in infrastructure costs.

## Tech stack

- **Runtime**: Node.js 20+, TypeScript ESM (`tsx` for dev, no build step needed)
- **HTTP**: `undici` with `ProxyAgent` pool (never recreated per-request)
- **HTML parsing**: `cheerio`
- **DB**: `better-sqlite3` (WAL mode, `busy_timeout=5000`, FK constraints)
- **Concurrency**: `p-queue`
- **Logging**: `pino` + `pino-pretty` (TTY) + `pino-roll` (file rotation, skipped in test env)
- **CLI**: `commander`
- **CSV**: `csv-stringify` streaming via `node:stream/promises pipeline()`
- **Testing**: `vitest`

## Commands

```bash
npm test                                        # run all 63 tests
npx tsx src/index.ts discover                   # Phase 1: find URLs
npx tsx src/index.ts scrape --limit 50          # Phase 2: scrape pages
npx tsx src/index.ts emails --tier 1            # Phase 3: extract emails
npx tsx src/index.ts retry-captcha --apify      # Phase 4: captcha bypass
npx tsx src/index.ts export                     # Phase 5: write CSV
npx tsx src/index.ts stats --email              # progress dashboard
npx tsx src/index.ts run --limit 100 --verbose  # full pipeline (testing)
```

## Project layout

```
src/
  index.ts              CLI entry point
  config.ts             Lazy getter config (all values read from process.env at first use)
  discovery/
    sitemap.ts          Sitemap parsing (.gz via fetchPageBuffer, fetchDirect bypasses proxy)
    category-crawl.ts   Category tree (depth≤4, visited Set, RateLimiter, numeric pagination)
    url-store.ts        UrlStore — RETURNING * claimBatch, lazy prepared stmts, attempts reset
    apify-discovery.ts  Keyword-based Apify gap-fill
  scraper/
    request.ts          fetchPage / fetchDirect / fetchPageBuffer / fetchExternal
    trustpilot.ts       JSON-LD → microdata → CSS → slug extraction
    worker-pool.ts      p-queue workers; SIGINT releases claimed batch; processed++ all paths
    email-finder.ts     Tier 1: HTTP (60s cap, entity decode, non-2xx continues to contact pages)
    email-worker.ts     Tier 1/2/3 orchestration; iterate() streaming; 500-row batch txns
    firecrawl-email.ts  Tier 2: spawnSync (no shell injection)
    apify-email.ts      Tier 3: start+poll+abort, paginated listItems
  anti-bot/
    rate-limiter.ts     nextSlotAt token-slot (concurrent-safe); LRU domainBuckets
    proxy-manager.ts    Map<string,ProxyEntry> O(1); lazy load; quarantine persistence JSON
    captcha-handler.ts  CF markers + multilingual; deleted-profile → failed not captcha
    fingerprint.ts      Header bundles keyed by browser family (Chrome/Firefox/Safari)
    apify-fallback.ts   Captcha bypass: start+poll+abort; batch inserts 200/tx
  storage/
    db.ts               WAL, busy_timeout=5000, FK, stale rows reset only if >1h old
    models.ts           email_status union includes done_tier1/2/3, not_found_tier1/2/3
    csv-export.ts       Correlated subquery MAX(id); iterate() stream; pipeline()
  utils/
    logger.ts           Lazy pino Proxy (created on first use so --verbose works)
    retry.ts            withRetry(isRetryable); HttpError class; base-2 backoff; maxAttempts=3
    validators.ts       extractEmails (entity decode); filterEmails (freemail fallback only)
tests/
  scraper.test.ts       JSON-LD, fallback, captcha, email, domain, rating tests
  anti-bot.test.ts      RateLimiter (429, 403, recovery)
  discovery.test.ts     URL normalisation, sitemap regex, SQLite dedup
  captcha-handler.test.ts  CF detection, deleted-profile, multilingual, iframe (single/double quote)
  claim-batch.test.ts   RETURNING * disjoint batches
  csv-export.test.ts    Correlated subquery picks MAX(id) row
  email-decode.test.ts  Entity decode (&#64;, [at], AT, &#46;, etc.)
  rate-limiter-concurrent.test.ts  25 concurrent callers spread > 500ms
```

## Key architectural decisions

### Config is lazy (important)
`src/config.ts` uses JS getters, not a frozen object. Every property reads `process.env` at call time. This means `applyGlobalFlags()` in `index.ts` (which sets `process.env.DB_PATH`, `process.env.LOG_LEVEL`, etc.) takes effect before any module reads the config — fixing the silent CLI-flag-ignored bug.

### Prepared statements are lazy
All prepared statements in `url-store.ts`, `worker-pool.ts`, `email-worker.ts` use `??=` lazy getters so they bind to the correct DB after `--db` overrides `DB_PATH`.

### Logger is a Proxy
`src/utils/logger.ts` exports a `Proxy` that creates the real pino logger on first method call. This ensures `--verbose` (which sets `LOG_LEVEL=debug`) is applied before the logger reads `config.logLevel`.

### claimBatch uses RETURNING *
`url-store.ts claimBatch()` uses `UPDATE ... RETURNING *` (SQLite 3.35+). This returns only the rows just claimed by *this* transaction, preventing cross-process double-scraping.

### Rate limiter uses nextSlotAt
Old `lastRequest` scalar caused all concurrent workers to read the same value and fire simultaneously. `nextSlotAt` is mutated synchronously before any `await`, serialising slots correctly.

### 429 does NOT ban proxies
429 is a rate-limit signal (back off), not a proxy ban. Only timeout/ECONNRESET/ECONNREFUSED/AbortError ban a proxy. This prevents cascading "all proxies quarantined" storms.

### CSV export uses correlated subquery
`GROUP BY domain HAVING id = MAX(id)` is SQLite-quirk-broken (bare columns come from arbitrary row). The export query uses: `WHERE id = (SELECT MAX(id) FROM results r2 WHERE r2.domain = r1.domain)`.

### Firecrawl uses spawnSync not execSync
`execSync(\`firecrawl "${url}"\`)` was a shell injection vector. Now uses `spawnSync('firecrawl', [url, ...])` — arguments are passed separately, no shell expansion.

### Apify uses start+poll not .call()
`actor.call()` has no timeout and hangs forever on stuck runs. All Apify calls use `actor.start()` → poll `actor.run(id).get()` every 15s → `actor.abort()` after 30 minutes.

## Environment variables

See `.env.example` for the full list. Key ones:

| Var | Default | Notes |
|-----|---------|-------|
| `DB_PATH` | `data/scraper.db` | Override with `--db` flag |
| `LOG_LEVEL` | `info` | Override with `--verbose` flag |
| `CONCURRENCY` | `25` | Trustpilot scrape workers |
| `MAX_REQUESTS_PER_SECOND` | `10` | Auto-adapts on 429/403 |
| `PROXY_FILE` | `data/proxies.txt` | One proxy URL per line |
| `APIFY_TOKEN` | — | Required for Apify features |

`envBool` accepts: `true/false`, `1/0`, `yes/no`, `on/off`.

## Database schema

```sql
urls    (id, slug UNIQUE, trustpilot_url, status, attempts, created_at, updated_at)
        status: pending | scraping | done | failed | captcha

results (id, slug UNIQUE → urls(slug) ON DELETE CASCADE,
         trustpilot_url, domain, rating, email,
         email_status, domain_source, scraped_at)
        email_status: pending | done_tier1 | done_tier2 | done_tier3 |
                      not_found_tier1 | not_found_tier2 | not_found_tier3 | failed
```

## Testing notes

- `NODE_ENV=test` is set in `vitest.config.ts` — this disables `pino-roll` file transport
- Tests use in-memory SQLite (`process.env.DB_PATH = ':memory:'`)
- The concurrent rate-limiter test takes ~3.5 seconds (25 callers × 100ms intervals)
- All 63 tests must pass before merging changes: `npm test`

## Common pitfalls

- Never change `src/config.ts` back to a frozen object — CLI flags will silently stop working
- Never use `execSync` with template strings containing user data — use `spawnSync` with an array
- Never call `actor.call()` — use `actor.start()` + poll loop
- Never use `.all()` for large result sets — use `.iterate()` to stream rows
- Never call `getDb().prepare(...)` at module top-level — prepared statements must be inside functions/getters
- The `busy_timeout=5000` pragma is critical for concurrent writers — do not remove it
