import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const QUARANTINE_FILE = 'data/proxy-quarantine.json';

interface ProxyEntry {
  url: string;
  banCount: number;
  banTimestamps: number[];
  quarantinedUntil: number;
}

export class ProxyManager {
  // Map for O(1) lookup by URL; order array for round-robin
  private proxyMap = new Map<string, ProxyEntry>();
  private proxyOrder: string[] = [];
  private rrIndex = 0;
  private loaded = false;

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loaded = true;
      this.load();
    }
  }

  private load(): void {
    const entries: string[] = [];

    if (config.proxyUrl) entries.push(config.proxyUrl);

    try {
      const content = fs.readFileSync(config.proxyFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) entries.push(trimmed);
      }
    } catch {
      // No proxy file — OK if proxyUrl is set
    }

    const quarantine = this.loadQuarantine();

    for (const url of [...new Set(entries)]) {
      const entry: ProxyEntry = {
        url,
        banCount: quarantine[url]?.banCount ?? 0,
        banTimestamps: [],
        quarantinedUntil: quarantine[url]?.quarantinedUntil ?? 0,
      };
      this.proxyMap.set(url, entry);
      this.proxyOrder.push(url);
    }

    logger.info({ count: this.proxyMap.size }, 'Proxies loaded');
  }

  private loadQuarantine(): Record<string, { banCount: number; quarantinedUntil: number }> {
    try {
      return JSON.parse(fs.readFileSync(QUARANTINE_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }

  private persistQuarantine(): void {
    try {
      const dir = path.dirname(QUARANTINE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const out: Record<string, { banCount: number; quarantinedUntil: number }> = {};
      for (const [url, entry] of this.proxyMap) {
        if (entry.quarantinedUntil > Date.now()) {
          out[url] = { banCount: entry.banCount, quarantinedUntil: entry.quarantinedUntil };
        }
      }
      fs.writeFileSync(QUARANTINE_FILE, JSON.stringify(out));
    } catch {/* skip if fs write fails */}
  }

  getProxy(): string | null {
    this.ensureLoaded();
    if (this.proxyOrder.length === 0) return null;

    const now = Date.now();
    for (let i = 0; i < this.proxyOrder.length; i++) {
      const url = this.proxyOrder[(this.rrIndex + i) % this.proxyOrder.length]!;
      const entry = this.proxyMap.get(url)!;
      if (entry.quarantinedUntil <= now) {
        this.rrIndex = (this.rrIndex + i + 1) % this.proxyOrder.length;
        return url;
      }
    }
    return null; // all quarantined
  }

  reportBan(proxyUrl: string): void {
    this.ensureLoaded();
    const entry = this.proxyMap.get(proxyUrl);
    if (!entry) return;

    const now = Date.now();
    entry.banTimestamps = entry.banTimestamps.filter(t => now - t < 10 * 60 * 1000);
    entry.banTimestamps.push(now);
    entry.banCount++;

    if (entry.banTimestamps.length >= 5) {
      entry.quarantinedUntil = now + 30 * 60 * 1000;
      logger.warn({ proxy: proxyUrl }, 'Proxy quarantined for 30 minutes');
      this.persistQuarantine();
    }
  }

  reportSuccess(proxyUrl: string): void {
    this.ensureLoaded();
    const entry = this.proxyMap.get(proxyUrl);
    if (!entry) return;
    entry.banTimestamps = [];
    entry.banCount = 0;
  }

  getHealthyCount(): number {
    this.ensureLoaded();
    const now = Date.now();
    return this.proxyOrder.filter(url => (this.proxyMap.get(url)?.quarantinedUntil ?? 0) <= now).length;
  }

  getTotalCount(): number {
    this.ensureLoaded();
    return this.proxyMap.size;
  }

  hasProxies(): boolean {
    this.ensureLoaded();
    return this.proxyMap.size > 0;
  }
}

export const proxyManager = new ProxyManager();
