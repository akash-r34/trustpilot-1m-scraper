import { execSync } from 'child_process';
import { Command } from 'commander';
import { getDb, resetStaleScraping } from './storage/db.js';
import { UrlStore } from './discovery/url-store.js';
import { discoverFromSitemap } from './discovery/sitemap.js';
import { discoverFromCategories } from './discovery/category-crawl.js';
import { discoverFromApify } from './discovery/apify-discovery.js';
import { runScrapeWorkers } from './scraper/worker-pool.js';
import { runEmailWorkersTier1, runEmailWorkersTier2, runEmailWorkersTier3 } from './scraper/email-worker.js';
import { retryCaptchaWithApify } from './anti-bot/apify-fallback.js';
import { exportCsv } from './storage/csv-export.js';
import { logger } from './utils/logger.js';
import { logRobotsAtStartup } from './anti-bot/robots.js';

const program = new Command();

program
  .name('trustpilot-scraper')
  .description('1M+ Trustpilot business listing scraper')
  .version('1.0.0');

function applyGlobalFlags(opts: Record<string, unknown>) {
  if (opts['verbose']) process.env['LOG_LEVEL'] = 'debug';
  if (opts['db']) process.env['DB_PATH'] = String(opts['db']);
  if (opts['output']) process.env['OUTPUT_FILE'] = String(opts['output']);
  if (opts['proxyFile']) process.env['PROXY_FILE'] = String(opts['proxyFile']);
  if (opts['concurrency']) process.env['CONCURRENCY'] = String(opts['concurrency']);
}

// ─── discover ────────────────────────────────────────────────────────────────
program
  .command('discover')
  .description('Phase 1: Discover all Trustpilot business URLs')
  .option('--apify', 'Also run Apify search discovery for gap-fill')
  .option('--categories', 'Also run category tree crawl (slower)')
  .option('--dry-run', 'Parse sitemaps but do not store URLs')
  .option('--verbose', 'Debug logging')
  .action(async (opts) => {
    applyGlobalFlags(opts);
    await logRobotsAtStartup().catch(() => {});
    const urlStore = new UrlStore();

    logger.info('=== Phase 1: URL Discovery ===');
    const sitemap = await discoverFromSitemap(urlStore);
    logger.info({ inserted: sitemap }, 'Sitemap discovery done');

    if (opts['categories']) {
      const cats = await discoverFromCategories(urlStore);
      logger.info({ inserted: cats }, 'Category discovery done');
    }

    if (opts['apify']) {
      const apify = await discoverFromApify(urlStore);
      logger.info({ inserted: apify }, 'Apify discovery done');
    }

    printStats(urlStore);
  });

// ─── scrape ──────────────────────────────────────────────────────────────────
program
  .command('scrape')
  .description('Phase 2: Scrape Trustpilot business pages')
  .option('--concurrency <n>', 'Worker concurrency', '25')
  .option('--limit <n>', 'Max URLs to process (for testing)')
  .option('--verbose', 'Debug logging')
  .option('--db <path>', 'SQLite DB path')
  .option('--proxy-file <path>', 'Proxy list file')
  .action(async (opts) => {
    applyGlobalFlags(opts);
    await logRobotsAtStartup().catch(() => {});
    const urlStore = new UrlStore();

    const stale = resetStaleScraping();
    if (stale > 0) logger.info({ stale }, 'Reset stale scraping URLs to pending');

    logger.info('=== Phase 2: Trustpilot Page Scraping ===');
    await runScrapeWorkers(urlStore, {
      concurrency: opts['concurrency'] ? parseInt(opts['concurrency'], 10) : undefined,
      limit: opts['limit'] ? parseInt(opts['limit'], 10) : undefined,
    });

    printStats(urlStore);
  });

// ─── emails ──────────────────────────────────────────────────────────────────
program
  .command('emails')
  .description('Phase 3: Extract emails from business domains')
  .option('--firecrawl', 'Run Tier 2 (Firecrawl) on Tier 1 failures')
  .option('--apify', 'Run Tier 3 (Apify) batch enrichment')
  .option('--tier <n>', 'Only run specific tier (1, 2, or 3)')
  .option('--limit <n>', 'Max domains to process')
  .option('--concurrency <n>', 'Email worker concurrency')
  .option('--verbose', 'Debug logging')
  .action(async (opts) => {
    applyGlobalFlags(opts);
    await logRobotsAtStartup().catch(() => {});
    const limit = opts['limit'] ? parseInt(opts['limit'], 10) : undefined;
    const tier = opts['tier'] ? parseInt(opts['tier'], 10) : null;

    logger.info('=== Phase 3: Email Extraction ===');

    if (!tier || tier === 1) {
      await runEmailWorkersTier1({ limit, concurrency: opts['concurrency'] ? parseInt(opts['concurrency'], 10) : undefined });
    }

    if ((!tier || tier === 2) && (opts['firecrawl'] || tier === 2)) {
      await runEmailWorkersTier2({ limit });
    }

    if ((!tier || tier === 3) && (opts['apify'] || tier === 3)) {
      await runEmailWorkersTier3({ limit });
    }

    printEmailStats();
  });

// ─── export ──────────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Phase 5: Export results to CSV')
  .option('--output <path>', 'Output CSV path')
  .option('--verbose', 'Debug logging')
  .action(async (opts) => {
    applyGlobalFlags(opts);
    await logRobotsAtStartup().catch(() => {});
    logger.info('=== Phase 5: CSV Export ===');
    await exportCsv(opts['output']);
  });

// ─── retry-failed ─────────────────────────────────────────────────────────────
program
  .command('retry-failed')
  .description('Reset all failed URLs back to pending for re-scrape')
  .action(async () => {
    const urlStore = new UrlStore();
    const reset = urlStore.resetFailedUrls();
    logger.info({ reset }, 'Failed URLs reset to pending');
  });

// ─── retry-captcha ────────────────────────────────────────────────────────────
program
  .command('retry-captcha')
  .description('Retry captcha-blocked URLs')
  .option('--apify', 'Use Apify Actor for captcha bypass')
  .option('--concurrency <n>', 'Worker concurrency', '5')
  .action(async (opts) => {
    applyGlobalFlags(opts);
    await logRobotsAtStartup().catch(() => {});
    const urlStore = new UrlStore();

    if (opts['apify']) {
      const db = getDb();
      const captchaUrls = db.prepare(`SELECT trustpilot_url FROM urls WHERE status = 'captcha'`).all() as Array<{ trustpilot_url: string }>;
      const urls = captchaUrls.map(r => r.trustpilot_url);
      logger.info({ count: urls.length }, 'Sending captcha URLs to Apify');
      await retryCaptchaWithApify(urls);
    } else {
      process.env['MAX_REQUESTS_PER_SECOND'] = '1';
      await runScrapeWorkers(urlStore, {
        fromStatus: 'captcha',
        concurrency: opts['concurrency'] ? parseInt(opts['concurrency'], 10) : 5,
      });
    }

    printStats(urlStore);
  });

// ─── stats ────────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show scraper progress dashboard')
  .option('--email', 'Show email coverage breakdown')
  .action((opts) => {
    const urlStore = new UrlStore();
    printStats(urlStore);
    if (opts['email']) printEmailStats();
  });

// ─── run (full pipeline) ──────────────────────────────────────────────────────
program
  .command('run')
  .description('Run the full pipeline end-to-end')
  .option('--concurrency <n>', 'Scrape worker concurrency', '25')
  .option('--apify', 'Enable Apify integrations')
  .option('--firecrawl', 'Enable Firecrawl for email extraction')
  .option('--limit <n>', 'Limit URLs per phase (for testing)')
  .option('--skip-email', 'Skip email extraction phase')
  .option('--verbose', 'Debug logging')
  .action(async (opts) => {
    applyGlobalFlags(opts);
    await logRobotsAtStartup().catch(() => {});
    const urlStore = new UrlStore();
    const limit = opts['limit'] ? parseInt(opts['limit'], 10) : undefined;

    checkDiskSpace();

    // Phase 1
    logger.info('=== Phase 1: URL Discovery ===');
    const stale = resetStaleScraping();
    if (stale > 0) logger.info({ stale }, 'Reset stale URLs');

    await discoverFromSitemap(urlStore);
    await discoverFromCategories(urlStore);
    if (opts['apify']) await discoverFromApify(urlStore);
    printStats(urlStore);

    // Phase 2
    logger.info('=== Phase 2: Trustpilot Scraping ===');
    await runScrapeWorkers(urlStore, {
      concurrency: opts['concurrency'] ? parseInt(opts['concurrency'], 10) : undefined,
      limit,
    });

    // Phase 3
    if (!opts['skipEmail']) {
      logger.info('=== Phase 3: Email Extraction ===');
      await runEmailWorkersTier1({ limit });
      if (opts['firecrawl']) await runEmailWorkersTier2({ limit });
      if (opts['apify']) await runEmailWorkersTier3({ limit });
      printEmailStats();
    }

    // Phase 5
    logger.info('=== Phase 5: CSV Export ===');
    await exportCsv();

    logger.info('Pipeline complete!');
  });

// ─── helpers ──────────────────────────────────────────────────────────────────
function printStats(urlStore: UrlStore): void {
  const stats = urlStore.getStats();
  const successRate = stats.total > 0
    ? ((stats.done / stats.total) * 100).toFixed(1)
    : '0';

  console.log('\n=== Trustpilot Scraper Stats ===');
  console.log(`URLs discovered:    ${stats.total.toLocaleString()}`);
  console.log(`Scrape pending:     ${stats.pending.toLocaleString()}`);
  console.log(`Scrape done:        ${stats.done.toLocaleString()}`);
  console.log(`Scrape failed:      ${stats.failed.toLocaleString()}`);
  console.log(`Scrape captcha:     ${stats.captcha.toLocaleString()}`);
  console.log(`Success rate:       ${successRate}%`);
  console.log('');
}

function printEmailStats(): void {
  const db = getDb();
  const rows = db.prepare(
    `SELECT email_status, COUNT(*) as count FROM results GROUP BY email_status`
  ).all() as Array<{ email_status: string; count: number }>;

  const map: Record<string, number> = {};
  for (const r of rows) map[r.email_status] = r.count;

  const totalWithEmail = (db.prepare(
    `SELECT COUNT(*) as n FROM results WHERE email IS NOT NULL AND email != ''`
  ).get() as { n: number }).n;
  const total = (db.prepare(`SELECT COUNT(*) as n FROM results`).get() as { n: number }).n;

  const tier1 = (map['done_tier1'] ?? 0);
  const tier2 = (map['done_tier2'] ?? 0);
  const tier3 = (map['done_tier3'] ?? 0);
  const doneLegacy = (map['done'] ?? 0); // rows from before tier tracking

  console.log('── Email Coverage ──');
  console.log(`Total with email:   ${totalWithEmail.toLocaleString()} (${total > 0 ? ((totalWithEmail / total) * 100).toFixed(1) : 0}%)`);
  console.log(`  Tier 1 (direct):  ${(tier1 + doneLegacy).toLocaleString()}`);
  console.log(`  Tier 2 Firecrawl: ${tier2.toLocaleString()}`);
  console.log(`  Tier 3 Apify:     ${tier3.toLocaleString()}`);
  console.log(`Not found Tier 1:   ${(map['not_found_tier1'] ?? 0).toLocaleString()}`);
  console.log(`Not found Tier 2:   ${(map['not_found_tier2'] ?? 0).toLocaleString()}`);
  console.log(`Not found Tier 3:   ${(map['not_found_tier3'] ?? 0).toLocaleString()}`);
  console.log(`Pending:            ${(map['pending'] ?? 0).toLocaleString()}`);
  console.log('');
}

function checkDiskSpace(): void {
  try {
    const out = execSync("df -k . | tail -1 | awk '{print $4}'").toString().trim();
    const freeKb = parseInt(out, 10);
    if (!isNaN(freeKb) && freeKb < 5 * 1024 * 1024) {
      logger.warn({ freeGb: (freeKb / 1024 / 1024).toFixed(1) }, 'Less than 5GB disk space available!');
    }
  } catch {/* skip — df may not be available on all platforms */}
}

program.parseAsync(process.argv).catch(err => {
  logger.error({ err: String(err) }, 'Fatal error');
  process.exit(1);
});
