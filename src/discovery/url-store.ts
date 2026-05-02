import Database from 'better-sqlite3';
import { getDb } from '../storage/db.js';
import { config } from '../config.js';
import type { UrlRecord, ScrapeStats } from '../storage/models.js';

export class UrlStore {
  // Lazy prepared statements — defer creation until first use so CLI
  // flags that override DB_PATH take effect before statements bind to a DB.
  private _insertStmt?: Database.Statement;
  private _doneStmt?: Database.Statement;
  private _failedStmt?: Database.Statement;
  private _captchaStmt?: Database.Statement;
  private _resetCaptchaStmt?: Database.Statement;
  private _resetFailedStmt?: Database.Statement;

  private get insertStmt() {
    return (this._insertStmt ??= getDb().prepare(
      `INSERT OR IGNORE INTO urls (slug, trustpilot_url) VALUES (?, ?)`
    ));
  }

  private get doneStmt() {
    return (this._doneStmt ??= getDb().prepare(
      `UPDATE urls SET status = 'done', attempts = 0, updated_at = datetime('now') WHERE slug = ?`
    ));
  }

  private get failedStmt() {
    return (this._failedStmt ??= getDb().prepare(
      `UPDATE urls
       SET status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
           attempts = attempts + 1,
           updated_at = datetime('now')
       WHERE slug = ?`
    ));
  }

  private get captchaStmt() {
    return (this._captchaStmt ??= getDb().prepare(
      `UPDATE urls SET status = 'captcha', updated_at = datetime('now') WHERE slug = ?`
    ));
  }

  private get resetCaptchaStmt() {
    return (this._resetCaptchaStmt ??= getDb().prepare(
      `UPDATE urls SET status = 'pending', attempts = 0, updated_at = datetime('now') WHERE status = 'captcha'`
    ));
  }

  private get resetFailedStmt() {
    return (this._resetFailedStmt ??= getDb().prepare(
      `UPDATE urls SET status = 'pending', attempts = 0, updated_at = datetime('now') WHERE status = 'failed'`
    ));
  }

  insertUrl(slug: string, fullUrl: string): void {
    this.insertStmt.run(slug, fullUrl);
  }

  insertBatch(entries: Array<{ slug: string; url: string }>): number {
    const db = getDb();
    const insert = db.prepare(`INSERT OR IGNORE INTO urls (slug, trustpilot_url) VALUES (?, ?)`);
    const tx = db.transaction((rows: typeof entries) => {
      let inserted = 0;
      for (const { slug, url } of rows) {
        const r = insert.run(slug, url);
        inserted += r.changes;
      }
      return inserted;
    });
    return tx(entries) as number;
  }

  claimBatch(batchSize: number, fromStatus: 'pending' | 'captcha' = 'pending'): UrlRecord[] {
    const db = getDb();
    // RETURNING * gives back only the rows just claimed — prevents cross-process
    // double-scraping that occurred when SELECT WHERE status='scraping' returned
    // all rows from any concurrent scraper process.
    const stmt = db.prepare(`
      UPDATE urls
      SET status = 'scraping', updated_at = datetime('now')
      WHERE slug IN (
        SELECT slug FROM urls WHERE status = ? ORDER BY id ASC LIMIT ?
      )
      RETURNING *
    `);
    return db.transaction(() => stmt.all(fromStatus, batchSize))() as UrlRecord[];
  }

  markDone(slug: string): void {
    this.doneStmt.run(slug);
  }

  markFailed(slug: string): void {
    this.failedStmt.run(config.maxRetries, slug);
  }

  markCaptcha(slug: string): void {
    this.captchaStmt.run(slug);
  }

  resetCaptchaUrls(): number {
    return this.resetCaptchaStmt.run().changes;
  }

  resetFailedUrls(): number {
    return this.resetFailedStmt.run().changes;
  }

  getStats(): ScrapeStats {
    const db = getDb();
    const rows = db.prepare(
      `SELECT status, COUNT(*) as count FROM urls GROUP BY status`
    ).all() as Array<{ status: string; count: number }>;
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = r.count;
    const pending = map['pending'] ?? 0;
    const scraping = map['scraping'] ?? 0;
    const done = map['done'] ?? 0;
    const failed = map['failed'] ?? 0;
    const captcha = map['captcha'] ?? 0;
    return { pending, scraping, done, failed, captcha, total: pending + scraping + done + failed + captcha };
  }

  getCount(): number {
    const db = getDb();
    const r = db.prepare(`SELECT COUNT(*) as n FROM urls`).get() as { n: number };
    return r.n;
  }
}
