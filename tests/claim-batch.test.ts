import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

describe('claimBatch — RETURNING prevents cross-process double-scraping', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        trustpilot_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Insert 10 pending rows
    const insert = db.prepare(`INSERT INTO urls (slug, trustpilot_url) VALUES (?, ?)`);
    for (let i = 1; i <= 10; i++) {
      insert.run(`slug${i}`, `https://trustpilot.com/review/company${i}.com`);
    }
  });

  afterEach(() => {
    db.close();
  });

  it('two concurrent claimers receive disjoint slug sets via RETURNING', () => {
    const claimStmt = db.prepare(`
      UPDATE urls
      SET status = 'scraping', updated_at = datetime('now')
      WHERE slug IN (
        SELECT slug FROM urls WHERE status = 'pending' ORDER BY id ASC LIMIT ?
      )
      RETURNING *
    `);

    // Simulate two concurrent processes each claiming 5
    const batch1 = db.transaction(() => claimStmt.all(5))() as Array<{ slug: string }>;
    const batch2 = db.transaction(() => claimStmt.all(5))() as Array<{ slug: string }>;

    const slugs1 = new Set(batch1.map(r => r.slug));
    const slugs2 = new Set(batch2.map(r => r.slug));

    // No slug should appear in both batches
    const overlap = [...slugs1].filter(s => slugs2.has(s));
    expect(overlap).toHaveLength(0);

    // Together they cover all 10 rows
    expect(slugs1.size + slugs2.size).toBe(10);
  });

  it('a third claim on exhausted pending pool returns empty', () => {
    const claimStmt = db.prepare(`
      UPDATE urls
      SET status = 'scraping', updated_at = datetime('now')
      WHERE slug IN (
        SELECT slug FROM urls WHERE status = 'pending' ORDER BY id ASC LIMIT ?
      )
      RETURNING *
    `);

    db.transaction(() => claimStmt.all(10))();
    const third = db.transaction(() => claimStmt.all(10))() as unknown[];
    expect(third).toHaveLength(0);
  });
});
