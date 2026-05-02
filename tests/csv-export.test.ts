import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Use in-memory DB for the export test
process.env['DB_PATH'] = ':memory:';

describe('CSV export — correlated subquery picks MAX(id) row', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        trustpilot_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'done',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        trustpilot_url TEXT NOT NULL,
        domain TEXT,
        rating REAL,
        email TEXT,
        email_status TEXT DEFAULT 'done',
        domain_source TEXT DEFAULT 'json_ld',
        scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the row with the highest id when domain is duplicated', () => {
    // Insert two rows with the same domain but different id/email/rating
    db.exec(`INSERT INTO results (slug, trustpilot_url, domain, rating, email) VALUES
      ('slug1', 'https://tp.com/review/acme.com', 'acme.com', 3.1, 'old@acme.com'),
      ('slug2', 'https://tp.com/review/acme.com', 'acme.com', 4.5, 'new@acme.com')`);

    const row = db.prepare(`
      SELECT trustpilot_url, domain, rating, email
      FROM results r1
      WHERE id = (SELECT MAX(id) FROM results r2 WHERE r2.domain = r1.domain)
        AND domain IS NOT NULL
      ORDER BY domain ASC
    `).get() as { rating: number; email: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.rating).toBe(4.5);
    expect(row!.email).toBe('new@acme.com');
  });

  it('excludes rows where domain IS NULL', () => {
    db.exec(`INSERT INTO results (slug, trustpilot_url, domain) VALUES
      ('s1', 'https://tp.com/review/null-domain', NULL)`);

    const rows = db.prepare(`
      SELECT * FROM results r1
      WHERE id = (SELECT MAX(id) FROM results r2 WHERE r2.domain = r1.domain)
        AND domain IS NOT NULL
    `).all();

    expect(rows).toHaveLength(0);
  });

  it('returns one row per domain', () => {
    db.exec(`INSERT INTO results (slug, trustpilot_url, domain) VALUES
      ('s1', 'https://tp.com/review/a.com', 'a.com'),
      ('s2', 'https://tp.com/review/a.com', 'a.com'),
      ('s3', 'https://tp.com/review/b.com', 'b.com')`);

    const rows = db.prepare(`
      SELECT domain FROM results r1
      WHERE id = (SELECT MAX(id) FROM results r2 WHERE r2.domain = r1.domain)
        AND domain IS NOT NULL
      ORDER BY domain
    `).all() as Array<{ domain: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.domain).toBe('a.com');
    expect(rows[1]!.domain).toBe('b.com');
  });
});
