import { ApifyClient } from 'apify-client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isValidEmail } from '../utils/validators.js';

const ACTOR_ID = 'vdrmota/contact-info-scraper';
const ACTOR_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 15_000;
const DATASET_PAGE_SIZE = 1000;

export async function enrichEmailsApify(domains: string[]): Promise<Map<string, string>> {
  if (!config.apifyToken) throw new Error('APIFY_TOKEN not set');

  const client = new ApifyClient({ token: config.apifyToken });
  // Pass original domain as userData so we can map results back without
  // re-parsing the actor's output URL (which may differ from the input).
  const startUrls = domains.map(d => ({
    url: `https://${d}`,
    userData: { domain: d },
  }));

  logger.info({ count: domains.length }, 'Starting Apify contact-info-scraper batch');

  const run = await client.actor(ACTOR_ID).start({
    startUrls,
    maxRequestsPerCrawl: domains.length * 3,
    proxyConfiguration: { useApifyProxy: true },
  });

  // Poll for completion with a hard timeout
  const deadline = Date.now() + ACTOR_TIMEOUT_MS;
  let finishedRun = await client.run(run.id).get();
  while (finishedRun && finishedRun.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    finishedRun = await client.run(run.id).get();
  }

  if (!finishedRun || finishedRun.status === 'RUNNING') {
    logger.warn({ runId: run.id }, 'Apify actor timed out, aborting');
    await client.run(run.id).abort().catch(() => {/* ignore abort errors */});
    return new Map();
  }

  // Paginate dataset to avoid the 1000-item silent truncation
  const result = new Map<string, string>();
  let offset = 0;
  while (true) {
    const page = await client.dataset(finishedRun.defaultDatasetId).listItems({ offset, limit: DATASET_PAGE_SIZE });
    for (const item of page.items as Record<string, unknown>[]) {
      const userData = item['userData'] as Record<string, string> | undefined;
      const domain = userData?.['domain'] ?? String(item['url'] ?? '');
      const emails = (item['emails'] as string[] | undefined) ?? [];
      for (const email of emails) {
        if (isValidEmail(email) && !result.has(domain)) {
          result.set(domain, email);
          break;
        }
      }
    }
    if (page.items.length < DATASET_PAGE_SIZE) break;
    offset += DATASET_PAGE_SIZE;
  }

  logger.info({ found: result.size, total: domains.length }, 'Apify email enrichment complete');
  return result;
}
