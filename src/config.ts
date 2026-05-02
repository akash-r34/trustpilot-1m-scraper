import 'dotenv/config';
import path from 'path';

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  const lower = v.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lower)) return true;
  if (['false', '0', 'no', 'off'].includes(lower)) return false;
  return fallback;
}

// Getters ensure env vars are read at first use, not at module load.
// This means CLI flags that mutate process.env (applyGlobalFlags in index.ts)
// take effect before any module reads them.
export const config = {
  get proxyUrl() { return envStr('PROXY_URL', ''); },
  get proxyFile() { return envStr('PROXY_FILE', 'data/proxies.txt'); },
  get concurrency() { return envInt('CONCURRENCY', 25); },
  get emailConcurrency() { return envInt('EMAIL_CONCURRENCY', 10); },
  get maxRequestsPerSecond() { return envInt('MAX_REQUESTS_PER_SECOND', 10); },
  get retryDelayMs() { return envInt('RETRY_DELAY_MS', 1000); },
  get maxRetries() { return envInt('MAX_RETRIES', 3); },
  get dbPath() { return envStr('DB_PATH', 'data/scraper.db'); },
  get outputDir() { return envStr('OUTPUT_DIR', 'output'); },
  get userAgentsFile() { return envStr('USER_AGENTS_FILE', 'data/user-agents.txt'); },
  get pageTimeoutMs() { return envInt('PAGE_TIMEOUT_MS', 30000); },
  get emailTimeoutMs() { return envInt('EMAIL_TIMEOUT_MS', 15000); },
  get apifyToken() { return envStr('APIFY_TOKEN', ''); },
  get firecrawlApiKey() { return envStr('FIRECRAWL_API_KEY', ''); },
  get skipEmailPhase() { return envBool('SKIP_EMAIL_PHASE', false); },
  get useFirecrawlEmails() { return envBool('USE_FIRECRAWL_EMAILS', false); },
  get useApifyFallback() { return envBool('USE_APIFY_FALLBACK', false); },
  get useApifyEmails() { return envBool('USE_APIFY_EMAILS', false); },
  get respectRobots() { return envBool('RESPECT_ROBOTS', false); },
  get logLevel() { return envStr('LOG_LEVEL', 'info'); },
  get outputFile() { return path.join(envStr('OUTPUT_DIR', 'output'), 'trustpilot_results.csv'); },
};

export type Config = typeof config;
