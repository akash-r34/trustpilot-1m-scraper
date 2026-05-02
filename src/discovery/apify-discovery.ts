import { ApifyClient } from 'apify-client';
import { UrlStore } from './url-store.js';
import { slugFromUrl, normalizeUrl } from '../utils/validators.js';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const DATASET_PAGE_SIZE = 1000;
const ACTOR_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;

const SEARCH_KEYWORDS = [
  'software', 'retail', 'bank', 'insurance', 'hotel', 'restaurant', 'travel',
  'health', 'beauty', 'fashion', 'electronics', 'automotive', 'real estate',
  'education', 'finance', 'telecom', 'logistics', 'marketing', 'consulting',
  'construction', 'food', 'grocery', 'pharmacy', 'legal', 'accounting',
];

export async function discoverFromApify(urlStore: UrlStore): Promise<number> {
  if (!config.apifyToken) {
    logger.warn('APIFY_TOKEN not set, skipping Apify discovery');
    return 0;
  }

  const client = new ApifyClient({ token: config.apifyToken });
  let totalInserted = 0;

  for (const keyword of SEARCH_KEYWORDS) {
    try {
      logger.info({ keyword }, 'Running Apify Trustpilot search');

      const run = await withRetry(
        () => client.actor('zerobreak~trustpilot-search-scraper').start({
          searchQuery: keyword,
          maxResults: 1000,
        }),
        { maxAttempts: 2, baseDelayMs: 5000, label: `apify-discover-${keyword}` }
      );

      // Poll until done
      const deadline = Date.now() + ACTOR_TIMEOUT_MS;
      let finishedRun = await client.run(run.id).get();
      while (finishedRun && finishedRun.status === 'RUNNING' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        finishedRun = await client.run(run.id).get();
      }
      if (!finishedRun || finishedRun.status === 'RUNNING') {
        logger.warn({ keyword, runId: run.id }, 'Apify search timed out, aborting');
        await client.run(run.id).abort().catch(() => {/* ignore */});
        continue;
      }

      // Paginate dataset
      const entries: Array<{ slug: string; url: string }> = [];
      let offset = 0;
      while (true) {
        const page = await client.dataset(finishedRun.defaultDatasetId).listItems({ offset, limit: DATASET_PAGE_SIZE });
        for (const item of page.items as Record<string, unknown>[]) {
          const url = String(item['url'] ?? item['trustpilotUrl'] ?? '');
          if (!url.includes('trustpilot.com/review/')) continue;
          const normalized = normalizeUrl(url);
          const slug = slugFromUrl(normalized);
          if (slug) entries.push({ slug, url: normalized });
        }
        if (page.items.length < DATASET_PAGE_SIZE) break;
        offset += DATASET_PAGE_SIZE;
      }

      const inserted = urlStore.insertBatch(entries);
      totalInserted += inserted;
      logger.info({ keyword, found: entries.length, inserted }, 'Apify search complete');
    } catch (err) {
      logger.warn({ keyword, err: String(err) }, 'Apify search failed for keyword');
    }
  }

  logger.info({ totalInserted }, 'Apify discovery complete');
  return totalInserted;
}
