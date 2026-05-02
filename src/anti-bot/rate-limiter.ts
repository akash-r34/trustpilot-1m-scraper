import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';

const DOMAIN_BUCKET_MAX = 5000;

export class RateLimiter {
  private rate: number;
  private readonly maxRate: number;
  private readonly minRate = 0.5;
  // nextSlotAt serialises concurrent callers: each caller atomically reserves
  // the next available time slot before awaiting, so bursts of N workers don't
  // all fire at the same instant.
  private nextSlotAt = 0;
  private consecutiveSuccesses = 0;
  private domainBuckets = new Map<string, number>(); // last-request time per domain

  constructor(ratePerSecond = config.maxRequestsPerSecond) {
    this.rate = ratePerSecond;
    this.maxRate = ratePerSecond;
  }

  async throttle(): Promise<void> {
    const minInterval = 1000 / this.rate;
    // Atomically claim the next slot (synchronous before any await)
    const slot = Math.max(Date.now(), this.nextSlotAt);
    this.nextSlotAt = slot + minInterval + Math.random() * 100;
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);
  }

  async throttleDomain(domain: string, maxPerSecond = 0.2): Promise<void> {
    const minInterval = 1000 / maxPerSecond;
    const last = this.domainBuckets.get(domain) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < minInterval) {
      await sleep(minInterval - elapsed + Math.random() * 200);
    }
    this.domainBuckets.set(domain, Date.now());

    // LRU eviction: keep at most DOMAIN_BUCKET_MAX entries
    if (this.domainBuckets.size > DOMAIN_BUCKET_MAX) {
      const oldestKey = this.domainBuckets.keys().next().value!;
      this.domainBuckets.delete(oldestKey);
    }
  }

  onSuccess(): void {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= 3 && this.rate < this.maxRate) {
      this.rate = Math.min(this.maxRate, this.rate * 1.1);
      this.consecutiveSuccesses = 0;
    }
  }

  async on429(retryAfterHeader?: string): Promise<void> {
    this.consecutiveSuccesses = 0;
    this.rate = Math.max(this.minRate, this.rate / 2);
    const waitSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
    const wait = (isNaN(waitSeconds) ? 60 : waitSeconds) * 1000;
    logger.warn({ newRate: this.rate, waitMs: wait }, 'Rate limit hit (429), backing off');
    await sleep(wait);
  }

  on403(): void {
    this.consecutiveSuccesses = 0;
    this.rate = Math.max(this.minRate, this.rate * 0.75);
    logger.warn({ newRate: this.rate }, 'Forbidden (403), reducing rate');
  }

  getCurrentRate(): number {
    return this.rate;
  }
}

export const rateLimiter = new RateLimiter();
