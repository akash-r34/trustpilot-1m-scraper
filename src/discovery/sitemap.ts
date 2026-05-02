import { gunzipSync } from 'zlib';
import * as cheerio from 'cheerio';
import { fetchPageBuffer } from '../scraper/request.js';
import { UrlStore } from './url-store.js';
import { normalizeUrl, slugFromUrl } from '../utils/validators.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { loadRobots } from '../anti-bot/robots.js';

// Accepts www.trustpilot.com and locale-prefixed variants (uk.trustpilot.com, de.trustpilot.com)
// Also allows locale path prefix (/uk/review/, /de/review/)
const REVIEW_URL_REGEX = /^https?:\/\/(?:[a-z]{2}\.)?(?:www\.)?trustpilot\.com\/(?:[a-z]{2}\/)?review\/[^\s/?#]+/i;

const REVIEW_SITEMAP_PATTERNS = [/review/i, /business/i, /companies/i, /profile/i];

async function fetchXml(url: string): Promise<string> {
  return withRetry(async () => {
    if (url.endsWith('.gz')) {
      // Fetch raw bytes with Accept-Encoding: identity to prevent
      // undici auto-decompressing, then gunzip ourselves.
      const { buffer, statusCode } = await fetchPageBuffer(url);
      if (statusCode >= 400) throw new Error(`HTTP ${statusCode} for ${url}`);
      return gunzipSync(buffer).toString('utf-8');
    }
    const { html, statusCode } = await fetchDirect(url);
    if (statusCode >= 400) throw new Error(`HTTP ${statusCode} for ${url}`);
    return html;
  }, { maxAttempts: 3, baseDelayMs: 1000, label: `sitemap:${url}` });
}

async function parseSitemapIndex(xml: string): Promise<string[]> {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  $('sitemap > loc').each((_, el) => {
    urls.push($(el).text().trim());
  });
  return urls;
}

async function parseSitemapUrls(xml: string): Promise<string[]> {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  $('url > loc').each((_, el) => {
    const u = $(el).text().trim();
    if (REVIEW_URL_REGEX.test(u)) {
      urls.push(normalizeUrl(u));
    }
  });
  return urls;
}

async function getRootSitemapUrl(): Promise<string> {
  const rules = await loadRobots();
  return rules.sitemap ?? 'https://www.trustpilot.com/sitemap_index.xml';
}

export async function discoverFromSitemap(urlStore: UrlStore): Promise<number> {
  logger.info('Starting sitemap discovery');

  const indexUrl = await getRootSitemapUrl();
  logger.info({ indexUrl }, 'Fetching sitemap index');

  let indexXml: string;
  try {
    indexXml = await fetchXml(indexUrl);
  } catch (err) {
    logger.error({ err: String(err) }, 'Failed to fetch sitemap index, falling back');
    return 0;
  }

  const childSitemaps = await parseSitemapIndex(indexXml);
  const reviewSitemaps = childSitemaps.filter(u =>
    REVIEW_SITEMAP_PATTERNS.some(p => p.test(u))
  );

  logger.info({ total: childSitemaps.length, review: reviewSitemaps.length }, 'Found child sitemaps');

  let totalInserted = 0;

  for (let i = 0; i < reviewSitemaps.length; i++) {
    const sitemapUrl = reviewSitemaps[i]!;
    try {
      logger.debug({ sitemapUrl, progress: `${i + 1}/${reviewSitemaps.length}` }, 'Parsing sitemap');
      const xml = await fetchXml(sitemapUrl);
      const urls = await parseSitemapUrls(xml);

      // Only insert URLs whose slug parses cleanly — drop any that would pollute
      // urls.slug with a full URL or garbage.
      const entries: Array<{ slug: string; url: string }> = [];
      for (const u of urls) {
        const slug = slugFromUrl(u);
        if (slug) entries.push({ slug, url: u });
      }

      const inserted = urlStore.insertBatch(entries);
      totalInserted += inserted;
      logger.info({ sitemapUrl, found: urls.length, inserted }, 'Sitemap processed');
    } catch (err) {
      logger.warn({ sitemapUrl, err: String(err) }, 'Failed to process sitemap, skipping');
    }
  }

  logger.info({ totalInserted }, 'Sitemap discovery complete');
  return totalInserted;
}
