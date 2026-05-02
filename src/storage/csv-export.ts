import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { stringify } from 'csv-stringify';
import { getDb } from './db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface QualityReport {
  totalRows: number;
  withEmail: number;
  withoutEmail: number;
  nullDomains: number;
  invalidRatings: number;
  duplicateDomains: number;
  invalidEmails: number;
  domainSources: Record<string, number>;
  emailStatuses: Record<string, number>;
}

function runQualityChecks(): QualityReport {
  const db = getDb();

  const totalRows = (db.prepare(`SELECT COUNT(*) as n FROM results WHERE domain IS NOT NULL`).get() as { n: number }).n;
  const withEmail = (db.prepare(`SELECT COUNT(*) as n FROM results WHERE email IS NOT NULL AND email != ''`).get() as { n: number }).n;
  const nullDomains = (db.prepare(`SELECT COUNT(*) as n FROM results WHERE domain IS NULL`).get() as { n: number }).n;
  const invalidRatings = (db.prepare(`SELECT COUNT(*) as n FROM results WHERE rating IS NOT NULL AND (rating < 1.0 OR rating > 5.0)`).get() as { n: number }).n;
  const duplicateDomains = (db.prepare(`SELECT COUNT(*) as n FROM (SELECT domain, COUNT(*) as c FROM results WHERE domain IS NOT NULL GROUP BY domain HAVING c > 1)`).get() as { n: number }).n;

  // In-DB email format check — avoids loading all emails into JS memory
  const invalidEmails = (db.prepare(
    `SELECT COUNT(*) as n FROM results WHERE email IS NOT NULL AND email NOT GLOB '*@*.*'`
  ).get() as { n: number }).n;

  const domainSourceRows = db.prepare(`SELECT domain_source, COUNT(*) as count FROM results GROUP BY domain_source`).all() as Array<{ domain_source: string; count: number }>;
  const domainSources: Record<string, number> = {};
  for (const r of domainSourceRows) domainSources[r.domain_source] = r.count;

  const emailStatusRows = db.prepare(`SELECT email_status, COUNT(*) as count FROM results GROUP BY email_status`).all() as Array<{ email_status: string; count: number }>;
  const emailStatuses: Record<string, number> = {};
  for (const r of emailStatusRows) emailStatuses[r.email_status] = r.count;

  return {
    totalRows,
    withEmail,
    withoutEmail: totalRows - withEmail,
    nullDomains,
    invalidRatings,
    duplicateDomains,
    invalidEmails,
    domainSources,
    emailStatuses,
  };
}

export async function exportCsv(outputPath?: string): Promise<void> {
  const outPath = outputPath ?? config.outputFile;
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  logger.info('Running data quality checks before export...');
  const quality = runQualityChecks();

  if (quality.nullDomains > 0) logger.warn({ count: quality.nullDomains }, 'Rows with NULL domain (excluded from export)');
  if (quality.invalidRatings > 0) logger.warn({ count: quality.invalidRatings }, 'Rows with invalid ratings');
  if (quality.duplicateDomains > 0) logger.warn({ count: quality.duplicateDomains }, 'Duplicate domains detected');
  if (quality.invalidEmails > 0) logger.warn({ count: quality.invalidEmails }, 'Suspicious email formats found');

  logger.info({ domainSources: quality.domainSources, emailStatuses: quality.emailStatuses }, 'Data quality report');

  const db = getDb();
  // Correlated subquery picks the row with MAX(id) for each domain so the
  // returned trustpilot_url/rating/email are from that same row — not arbitrary.
  const stmt = db.prepare(`
    SELECT trustpilot_url, domain, rating, email
    FROM results r1
    WHERE id = (SELECT MAX(id) FROM results r2 WHERE r2.domain = r1.domain)
      AND domain IS NOT NULL
    ORDER BY domain ASC
  `);

  const writeStream = fs.createWriteStream(outPath, { encoding: 'utf8' });

  const stringifier = stringify({
    header: true,
    columns: [
      { key: 'trustpilot_url', header: 'trustpilot_url' },
      { key: 'domain', header: 'domain' },
      { key: 'rating', header: 'rating' },
      { key: 'email', header: 'email' },
    ],
    cast: {
      number: v => (v === null ? '' : String(v)),
      object: v => (v === null ? '' : String(v)),
    },
  });

  // Write BOM through the stringifier so if it errors, the writeStream
  // is still cleanly closed by pipeline().
  const bomBuffer = Buffer.from('\xEF\xBB\xBF');
  stringifier.write(bomBuffer.toString('utf8'));

  // pipeline() wires error handling and cleanup automatically.
  const pipelinePromise = pipeline(stringifier, writeStream);

  // Stream rows one-by-one to avoid loading 1M+ rows into memory.
  for (const row of stmt.iterate() as Iterable<{ trustpilot_url: string; domain: string; rating: number | null; email: string | null }>) {
    stringifier.write({
      trustpilot_url: row.trustpilot_url,
      domain: row.domain,
      rating: row.rating ?? '',
      email: row.email ?? '',
    });
  }
  stringifier.end();

  await pipelinePromise;

  const stats = fs.statSync(outPath);
  logger.info({
    outputPath: outPath,
    totalRows: quality.totalRows,
    withEmail: quality.withEmail,
    withoutEmail: quality.withoutEmail,
    fileSizeMb: (stats.size / 1024 / 1024).toFixed(2),
  }, 'CSV export complete');
}
