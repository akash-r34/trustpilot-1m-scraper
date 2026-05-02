import PQueue from 'p-queue';
import { getDb } from '../storage/db.js';
import { findEmail } from './email-finder.js';
import { findEmailFirecrawl } from './firecrawl-email.js';
import { enrichEmailsApify } from './apify-email.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const TIER3_BATCH_SIZE = 500;

function getUpdateEmailStmt() {
  return getDb().prepare(
    `UPDATE results SET email = ?, email_status = ?, scraped_at = datetime('now') WHERE slug = ?`
  );
}

export async function runEmailWorkersTier1(opts: { concurrency?: number; limit?: number } = {}): Promise<void> {
  const concurrency = opts.concurrency ?? config.emailConcurrency;
  const db = getDb();

  // Use a parameterised statement for the limit — no SQL interpolation
  const stmt = opts.limit !== undefined
    ? db.prepare(`SELECT slug, domain FROM results WHERE domain IS NOT NULL AND email_status = 'pending' ORDER BY id ASC LIMIT ?`)
    : db.prepare(`SELECT slug, domain FROM results WHERE domain IS NOT NULL AND email_status = 'pending' ORDER BY id ASC`);

  const total = opts.limit !== undefined
    ? (db.prepare(`SELECT COUNT(*) as n FROM results WHERE domain IS NOT NULL AND email_status = 'pending'`).get() as { n: number }).n
    : 0;

  logger.info({ limit: opts.limit ?? 'all' }, 'Starting Tier 1 email extraction');

  const updateEmail = getUpdateEmailStmt();
  const queue = new PQueue({ concurrency });
  let processed = 0;

  // Stream rows instead of loading all into memory
  const rows = (opts.limit !== undefined ? stmt.iterate(opts.limit) : stmt.iterate()) as Iterable<{ slug: string; domain: string }>;

  for (const { slug, domain } of rows) {
    // Backpressure: don't let the queue grow unboundedly
    if (queue.size > concurrency * 4) {
      await queue.onSizeLessThan(concurrency * 2);
    }

    queue.add(async () => {
      const { email, status } = await findEmail(domain);
      updateEmail.run(email, status, slug);
      processed++;
      if (processed % 1000 === 0) {
        logger.info({ processed, total: total || '?' }, 'Email Tier 1 progress');
      }
    }).catch(err => {
      updateEmail.run(null, 'failed', slug);
      logger.debug({ domain, err: String(err) }, 'Tier 1 email error');
    });
  }

  await queue.onIdle();
  logger.info({ processed }, 'Tier 1 email extraction complete');
}

export async function runEmailWorkersTier2(opts: { limit?: number } = {}): Promise<void> {
  const db = getDb();

  const stmt = opts.limit !== undefined
    ? db.prepare(`SELECT slug, domain FROM results WHERE domain IS NOT NULL AND email_status = 'not_found_tier1' ORDER BY id ASC LIMIT ?`)
    : db.prepare(`SELECT slug, domain FROM results WHERE domain IS NOT NULL AND email_status = 'not_found_tier1' ORDER BY id ASC`);

  const rows = (opts.limit !== undefined ? stmt.all(opts.limit) : stmt.all()) as Array<{ slug: string; domain: string }>;
  logger.info({ count: rows.length }, 'Starting Tier 2 email extraction (Firecrawl)');

  const updateEmail = getUpdateEmailStmt();
  let processed = 0;

  for (const { slug, domain } of rows) {
    try {
      const { email, status } = await findEmailFirecrawl(domain);
      updateEmail.run(email, status, slug);
      processed++;
      if (processed % 100 === 0) {
        logger.info({ processed, total: rows.length }, 'Email Tier 2 progress');
      }
    } catch (err) {
      updateEmail.run(null, 'not_found_tier2', slug);
      logger.debug({ domain, err: String(err) }, 'Tier 2 email error');
    }
  }

  logger.info({ processed }, 'Tier 2 email extraction complete');
}

export async function runEmailWorkersTier3(opts: { limit?: number } = {}): Promise<void> {
  const db = getDb();

  const stmt = opts.limit !== undefined
    ? db.prepare(`SELECT slug, domain FROM results WHERE domain IS NOT NULL AND (email_status = 'not_found_tier2' OR email_status = 'not_found_tier1') ORDER BY id ASC LIMIT ?`)
    : db.prepare(`SELECT slug, domain FROM results WHERE domain IS NOT NULL AND (email_status = 'not_found_tier2' OR email_status = 'not_found_tier1') ORDER BY id ASC`);

  const rows = (opts.limit !== undefined ? stmt.all(opts.limit) : stmt.all()) as Array<{ slug: string; domain: string }>;
  logger.info({ count: rows.length }, 'Starting Tier 3 email extraction (Apify)');

  const domains = rows.map(r => r.domain);
  const emailMap = await enrichEmailsApify(domains);

  const updateEmail = getUpdateEmailStmt();

  // Process updates in batches of TIER3_BATCH_SIZE to avoid locking
  // the DB for minutes with a single giant transaction.
  for (let i = 0; i < rows.length; i += TIER3_BATCH_SIZE) {
    const batchRows = rows.slice(i, i + TIER3_BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const { slug, domain } of batchRows) {
        const email = emailMap.get(domain) ?? null;
        updateEmail.run(email, email ? 'done_tier3' : 'not_found_tier3', slug);
      }
    });
    tx();
  }

  logger.info({ found: emailMap.size, total: domains.length }, 'Tier 3 email extraction complete');
}
