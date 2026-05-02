import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { getRandomHeaders } from '../anti-bot/fingerprint.js';
import { proxyManager } from '../anti-bot/proxy-manager.js';
import { rateLimiter } from '../anti-bot/rate-limiter.js';
import { withRetry, isRetryableError, HttpError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

export interface FetchResult {
  html: string;
  statusCode: number;
  proxyUsed: string | null;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB — real HTML pages are ≤2 MB

// Reuse ProxyAgent instances to avoid socket leaks
const proxyAgentCache = new Map<string, ProxyAgent>();

function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({ uri: proxyUrl, maxRedirections: 5 });
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

export function destroyProxyAgents(): void {
  for (const agent of proxyAgentCache.values()) {
    agent.destroy().catch(() => {/* ignore */});
  }
  proxyAgentCache.clear();
}

async function readBodyCapped(response: Response): Promise<string> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) {
      logger.debug({ url: response.url }, 'Response body exceeded 5 MB cap, truncating');
      break;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function fetchPage(url: string, opts: { skipRateLimit?: boolean } = {}): Promise<FetchResult> {
  return withRetry(async () => {
    if (!opts.skipRateLimit) await rateLimiter.throttle();

    const proxy = proxyManager.getProxy();
    const headers = getRandomHeaders();

    const dispatcher = proxy ? getProxyAgent(proxy) : undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pageTimeoutMs);

    try {
      const response = await undiciFetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);

      const html = await readBodyCapped(response);
      const statusCode = response.status;

      if (statusCode === 429) {
        // 429 is rate limiting — NOT a proxy ban, just back off
        await rateLimiter.on429(response.headers.get('retry-after') ?? undefined);
        throw new HttpError(429, `429 Too Many Requests for ${url}`);
      }

      if (statusCode === 403) {
        if (proxy) proxyManager.reportBan(proxy);
        rateLimiter.on403();
      } else if (statusCode >= 200 && statusCode < 300) {
        if (proxy) proxyManager.reportSuccess(proxy);
        rateLimiter.onSuccess();
      } else if (statusCode >= 400) {
        throw new HttpError(statusCode, `HTTP ${statusCode} for ${url}`);
      }

      return { html, statusCode, proxyUsed: proxy };
    } catch (err) {
      // AbortError or network failure — ban the proxy that was being used
      if (proxy && err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError' ||
           err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED') ||
           err.message.startsWith('UND_ERR'))) {
        proxyManager.reportBan(proxy);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }, {
    maxAttempts: config.maxRetries,
    baseDelayMs: config.retryDelayMs,
    label: url,
    isRetryable: isRetryableError,
  });
}

/** Fetch without proxy or rate-limiting — for sitemaps, robots.txt, etc. */
export async function fetchDirect(url: string): Promise<FetchResult> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pageTimeoutMs);
    try {
      const response = await undiciFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrustpilotScraper/1.0)' },
        signal: controller.signal,
        redirect: 'follow',
      } as Parameters<typeof undiciFetch>[1]);
      const html = await readBodyCapped(response);
      return { html, statusCode: response.status, proxyUsed: null };
    } finally {
      clearTimeout(timeout);
    }
  }, { maxAttempts: 3, baseDelayMs: 1000, label: `direct:${url}` });
}

/** Fetch raw bytes — needed for .gz sitemaps to avoid double-decompression. */
export async function fetchPageBuffer(url: string): Promise<{ buffer: Buffer; statusCode: number }> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pageTimeoutMs);
    try {
      const response = await undiciFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TrustpilotScraper/1.0)',
          'Accept-Encoding': 'identity', // prevent auto-decompression so we can gunzip ourselves
        },
        signal: controller.signal,
        redirect: 'follow',
      } as Parameters<typeof undiciFetch>[1]);

      if (response.status >= 400) throw new HttpError(response.status, `HTTP ${response.status} for ${url}`);

      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) break;
        chunks.push(Buffer.from(chunk));
      }
      return { buffer: Buffer.concat(chunks), statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }, { maxAttempts: 3, baseDelayMs: 1000, label: `buffer:${url}`, isRetryable: isRetryableError });
}

export async function fetchExternal(url: string): Promise<FetchResult> {
  return withRetry(async () => {
    const headers = getRandomHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.emailTimeoutMs);
    try {
      const response = await undiciFetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      } as Parameters<typeof undiciFetch>[1]);

      const html = await readBodyCapped(response);
      return { html, statusCode: response.status, proxyUsed: null };
    } catch (err) {
      logger.debug({ url, err: String(err) }, 'External fetch failed');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }, {
    maxAttempts: 2,
    baseDelayMs: 500,
    label: `external:${url}`,
    isRetryable: (err) => {
      // Don't retry on permanent 4xx
      if (err instanceof HttpError && err.statusCode >= 400 && err.statusCode < 500 &&
          err.statusCode !== 408 && err.statusCode !== 429) return false;
      return true;
    },
  });
}
