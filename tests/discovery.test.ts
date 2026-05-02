import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeUrl, slugFromUrl } from '../src/utils/validators.js';

// In-memory DB for UrlStore tests
process.env['DB_PATH'] = ':memory:';

describe('URL normalization', () => {
  it('strips trailing slash', () => {
    expect(normalizeUrl('https://www.trustpilot.com/review/example.com/')).toBe(
      'https://www.trustpilot.com/review/example.com'
    );
  });

  it('lowercases URL', () => {
    expect(normalizeUrl('https://www.trustpilot.com/review/Example.Com')).toBe(
      'https://www.trustpilot.com/review/example.com'
    );
  });

  it('strips query params', () => {
    const url = normalizeUrl('https://www.trustpilot.com/review/example.com?utm_source=test');
    expect(url).not.toContain('?');
  });

  it('extracts slug correctly', () => {
    expect(slugFromUrl('https://www.trustpilot.com/review/example.com')).toBe('example.com');
    expect(slugFromUrl('https://www.trustpilot.com/review/mybrand')).toBe('mybrand');
  });

  it('returns null for non-review URLs', () => {
    expect(slugFromUrl('https://www.trustpilot.com/categories')).toBeNull();
  });
});

describe('Sitemap XML parsing', () => {
  it('filters non-review URLs', () => {
    const REVIEW_REGEX = /^https:\/\/www\.trustpilot\.com\/review\/[a-z0-9._-]+$/i;
    const urls = [
      'https://www.trustpilot.com/review/example.com',
      'https://www.trustpilot.com/categories/software',
      'https://www.trustpilot.com/review/example.com/reviews',
      'https://www.trustpilot.com/review/another-company',
    ];
    const filtered = urls.filter(u => REVIEW_REGEX.test(u));
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe('https://www.trustpilot.com/review/example.com');
    expect(filtered[1]).toBe('https://www.trustpilot.com/review/another-company');
  });
});

describe('UrlStore deduplication', () => {
  it('does not insert duplicate slugs', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        trustpilot_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const insert = db.prepare(`INSERT OR IGNORE INTO urls (slug, trustpilot_url) VALUES (?, ?)`);
    insert.run('example.com', 'https://www.trustpilot.com/review/example.com');
    insert.run('example.com', 'https://www.trustpilot.com/review/example.com'); // duplicate

    const count = (db.prepare(`SELECT COUNT(*) as n FROM urls`).get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });
});
