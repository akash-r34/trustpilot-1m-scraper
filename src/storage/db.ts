import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = config.dbPath;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -64000'); // 64 MB page cache
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000'); // retry writes for 5 s before failing

  initSchema(_db);
  logger.debug({ dbPath }, 'Database initialized');
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      trustpilot_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_urls_status ON urls(status);
    CREATE INDEX IF NOT EXISTS idx_urls_slug ON urls(slug);

    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      trustpilot_url TEXT NOT NULL,
      domain TEXT,
      rating REAL,
      email TEXT,
      email_status TEXT DEFAULT 'pending',
      domain_source TEXT DEFAULT 'json_ld',
      scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (slug) REFERENCES urls(slug) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_results_domain ON results(domain);
    CREATE INDEX IF NOT EXISTS idx_results_email_status ON results(email_status);
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetStaleScraping(): number {
  const db = getDb();
  // Only reset rows claimed more than 1 hour ago — avoids cannibalising
  // a sibling process that is actively working on the same rows.
  const result = db.prepare(
    `UPDATE urls SET status = 'pending', updated_at = datetime('now')
     WHERE status = 'scraping' AND updated_at < datetime('now', '-1 hour')`
  ).run();
  return result.changes;
}
