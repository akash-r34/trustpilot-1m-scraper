import PQueue from 'p-queue';
import { getDb } from '../storage/db.js';
import { UrlStore } from '../discovery/url-store.js';
import { fetchPage } from './request.js';
import { parseTrustpilotPage } from './trustpilot.js';
import { isCaptchaPage, isDeletedProfile } from '../anti-bot/captcha-handler.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface WorkerOpts {
  concurrency?: number;
  limit?: number;
  fromStatus?: 'pending' | 'captcha';
}

export async function runScrapeWorkers(urlStore: UrlStore, opts: WorkerOpts = {}): Promise<void> {
  const concurrency = opts.concurrency ?? config.concurrency;
  const fromStatus = opts.fromStatus ?? 'pending';
  const queue = new PQueue({ concurrency });

  // Lazy prepared statement — inside the function body so it binds to the
  // correct DB after CLI flags (--db) have been applied.
  const insertResult = getDb().prepare(`
    INSERT OR REPLACE INTO results (slug, trustpilot_url, domain, rating, domain_source, email_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  let processed = 0;
  const startTime = Date.now();

  const logProgress = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? processed / elapsed : 0;
    const stats = urlStore.getStats();
    logger.info({
      done: stats.done,
      pending: stats.pending,
      failed: stats.failed,
      captcha: stats.captcha,
      rate: rate.toFixed(1) + '/s',
    }, 'Scrape progress');
  };

  const progressInterval = setInterval(logProgress, 60_000);

  let running = true;
  let claimedButUnstarted: typeof import('../storage/models.js').UrlRecord[] = [];

  const shutdown = () => {
    if (running) {
      running = false;
      logger.info('Graceful shutdown initiated, draining queue...');

      // Release any claimed-but-not-yet-started rows back to pending so a
      // sibling or future process can pick them up.
      if (claimedButUnstarted.length > 0) {
        const db = getDb();
        const release = db.prepare(
          `UPDATE urls SET status = 'pending', updated_at = datetime('now') WHERE slug = ? AND status = 'scraping'`
        );
        const tx = db.transaction(() => {
          for (const r of claimedButUnstarted) release.run(r.slug);
        });
        tx();
        logger.info({ count: claimedButUnstarted.length }, 'Released unclaimed batch back to pending');
      }
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const fillQueue = async () => {
    while (running) {
      if (queue.size > concurrency * 2) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      const batch = urlStore.claimBatch(Math.max(concurrency * 2, 100), fromStatus);
      if (batch.length === 0) break;

      claimedButUnstarted = batch.slice();

      for (const urlRecord of batch) {
        if (!running) break;
        if (opts.limit !== undefined && processed >= opts.limit) {
          running = false;
          break;
        }

        claimedButUnstarted = claimedButUnstarted.filter(r => r.slug !== urlRecord.slug);

        queue.add(async () => {
          const { slug, trustpilot_url } = urlRecord;
          try {
            const { html, statusCode } = await fetchPage(trustpilot_url);

            if (isCaptchaPage(html, statusCode)) {
              urlStore.markCaptcha(slug);
              logger.debug({ url: trustpilot_url }, 'Captcha detected');
              processed++;
              return;
            }

            if (isDeletedProfile(html, statusCode)) {
              urlStore.markFailed(slug);
              processed++;
              return;
            }

            if (statusCode >= 400) {
              urlStore.markFailed(slug);
              processed++;
              return;
            }

            const result = parseTrustpilotPage(html, trustpilot_url);
            insertResult.run(slug, result.trustpilot_url, result.domain, result.rating, result.domain_source);
            urlStore.markDone(slug);
            processed++;
          } catch (err) {
            logger.debug({ url: trustpilot_url, err: String(err) }, 'Scrape error');
            urlStore.markFailed(slug);
            processed++;
          }
        }).catch(err => logger.error({ err: String(err) }, 'Unexpected queue task error'));
      }
    }
  };

  await fillQueue();
  await queue.onIdle();

  clearInterval(progressInterval);
  logProgress();

  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
}
