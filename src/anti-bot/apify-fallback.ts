import { ApifyClient } from 'apify-client';
import { getDb } from '../storage/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { normalizeDomain, normalizeRating } from '../utils/validators.js';
import { withRetry } from '../utils/retry.js';

const ACTOR_ID = 'casper11515/trustpilot-reviews-scraper';
const ACTOR_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;
const DATASET_PAGE_SIZE = 1000;
const BATCH_INSERT_SIZE = 200;

export async function retryCaptchaWithApify(urls: string[]): Promise<number> {
  if (!config.apifyToken) throw new Error('APIFY_TOKEN not set');
  if (urls.length === 0) return 0;

  const client = new ApifyClient({ token: config.apifyToken });
  logger.info({ count: urls.length }, 'Sending captcha URLs to Apify');

  // Pass original slug as userData so results map back correctly even if the
  // actor follows redirects to a different URL.
  const startUrlsWithMeta = urls.map(u => {
    const slug = u.split('/review/')[1]?.split('?')[0]?.toLowerCase() ?? '';
    return { url: u, userData: { slug, originalUrl: u } };
  });

  const run = await withRetry(
    () => client.actor(ACTOR_ID).start({
      startUrls: startUrlsWithMeta,
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    }),
    { maxAttempts: 2, baseDelayMs: 5000, label: 'apify-fallback-start' }
  );

  // Poll until done or timeout
  const deadline = Date.now() + ACTOR_TIMEOUT_MS;
  let finishedRun = await client.run(run.id).get();
  while (finishedRun && finishedRun.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    finishedRun = await client.run(run.id).get();
  }

  if (!finishedRun || finishedRun.status === 'RUNNING') {
    logger.warn({ runId: run.id }, 'Apify captcha retry timed out, aborting');
    await client.run(run.id).abort().catch(() => {/* ignore */});
    return 0;
  }

  const db = getDb();
  const insertResult = db.prepare(`
    INSERT OR REPLACE INTO results (slug, trustpilot_url, domain, rating, domain_source, email_status)
    VALUES (?, ?, ?, ?, 'json_ld', 'pending')
  `);
  const markDone = db.prepare(`UPDATE urls SET status = 'done', updated_at = datetime('now') WHERE slug = ?`);

  let recovered = 0;
  let offset = 0;
  let batch: Record<string, unknown>[] = [];

  const flushBatch = () => {
    if (batch.length === 0) return;
    const tx = db.transaction(() => {
      for (const item of batch) {
        const userData = item['userData'] as Record<string, string> | undefined;
        const slug = userData?.['slug'] ?? String(item['pageUrl'] ?? item['url'] ?? '').split('/review/')[1]?.toLowerCase() ?? '';
        if (!slug) continue;
        const pageUrl = userData?.['originalUrl'] ?? String(item['url'] ?? item['pageUrl'] ?? '');
        const rawDomain = String(item['website'] ?? item['url'] ?? '');
        const domain = normalizeDomain(rawDomain);
        const rating = normalizeRating(item['trustScore'] ?? item['rating']);
        if (domain) {
          insertResult.run(slug, pageUrl, domain, rating);
          markDone.run(slug);
          recovered++;
        }
      }
    });
    tx();
    batch = [];
  };

  while (true) {
    const page = await client.dataset(finishedRun.defaultDatasetId).listItems({ offset, limit: DATASET_PAGE_SIZE });
    batch.push(...(page.items as Record<string, unknown>[]));
    if (batch.length >= BATCH_INSERT_SIZE) flushBatch();
    if (page.items.length < DATASET_PAGE_SIZE) break;
    offset += DATASET_PAGE_SIZE;
  }
  flushBatch();

  logger.info({ recovered, total: urls.length }, 'Apify captcha retry complete');
  return recovered;
}
