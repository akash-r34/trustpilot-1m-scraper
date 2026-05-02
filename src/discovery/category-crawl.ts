import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import { fetchPage } from '../scraper/request.js';
import { UrlStore } from './url-store.js';
import { normalizeUrl, slugFromUrl } from '../utils/validators.js';
import { RateLimiter } from '../anti-bot/rate-limiter.js';
import { logger } from '../utils/logger.js';

const BASE = 'https://www.trustpilot.com';
const REVIEW_REGEX = /^\/review\/[a-z0-9._-]+$/i;
const MAX_DEPTH = 4;
const CATEGORY_RATE = 0.5; // 1 req/2s for category pages

// Dedicated rate limiter so category crawl doesn't interfere with main scrape
const categoryRateLimiter = new RateLimiter(CATEGORY_RATE);

function extractReviewLinks($: cheerio.CheerioAPI): string[] {
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (REVIEW_REGEX.test(href)) {
      links.push(normalizeUrl(`${BASE}${href}`));
    }
  });
  return [...new Set(links)];
}

function extractCategoryLinks($: cheerio.CheerioAPI): string[] {
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (href.startsWith('/categories/')) {
      links.push(`${BASE}${href}`);
    }
  });
  return [...new Set(links)];
}

async function crawlCategoryPage(
  url: string,
  urlStore: UrlStore,
  queue: PQueue,
  visited: Set<string>,
  depth: number
): Promise<void> {
  if (visited.has(url) || depth > MAX_DEPTH) return;
  visited.add(url);

  await categoryRateLimiter.throttle();

  try {
    const { html, statusCode } = await fetchPage(url, { skipRateLimit: true });
    if (statusCode >= 400) return;

    const $ = cheerio.load(html);

    // Insert review links found on this page
    const reviewLinks = extractReviewLinks($);
    const entries = reviewLinks
      .map(u => ({ slug: slugFromUrl(u), url: u }))
      .filter((e): e is { slug: string; url: string } => e.slug !== null);
    if (entries.length > 0) urlStore.insertBatch(entries);

    // Recurse into subcategories
    if (depth < MAX_DEPTH) {
      const subCatLinks = extractCategoryLinks($);
      for (const subUrl of subCatLinks) {
        if (!visited.has(subUrl)) {
          queue.add(() => crawlCategoryPage(subUrl, urlStore, queue, visited, depth + 1));
        }
      }
    }

    // Paginate numerically: find the highest page number linked, then walk pages
    const pageNums: number[] = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const m = href.match(/[?&]page=(\d+)/);
      if (m) pageNums.push(parseInt(m[1]!, 10));
    });
    const maxPage = Math.max(...pageNums, 0);

    const baseUrl = url.split('?')[0]!;
    for (let page = 2; page <= maxPage; page++) {
      const pageUrl = `${baseUrl}?page=${page}`;
      if (!visited.has(pageUrl)) {
        queue.add(() => crawlCategoryPage(pageUrl, urlStore, queue, visited, depth));
      }
    }

    logger.debug({ url, found: reviewLinks.length, depth }, 'Category page crawled');
  } catch (err) {
    logger.warn({ url, err: String(err) }, 'Category page crawl failed');
  }
}

export async function discoverFromCategories(urlStore: UrlStore): Promise<number> {
  logger.info('Starting category tree discovery');

  const { html } = await fetchPage(`${BASE}/categories`);
  const $ = cheerio.load(html);
  const categoryLinks = extractCategoryLinks($);
  logger.info({ categories: categoryLinks.length }, 'Found top-level categories');

  const queue = new PQueue({ concurrency: 3 });
  const visited = new Set<string>();
  const before = urlStore.getCount();

  for (const catUrl of categoryLinks) {
    queue.add(() => crawlCategoryPage(catUrl, urlStore, queue, visited, 1));
  }

  await queue.onIdle();

  const inserted = urlStore.getCount() - before;
  logger.info({ inserted }, 'Category discovery complete');
  return inserted;
}
