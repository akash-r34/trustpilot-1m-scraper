import * as cheerio from 'cheerio';
import { normalizeDomain, normalizeRating, slugFromUrl } from '../utils/validators.js';
import { logger } from '../utils/logger.js';

export type DomainSource = 'json_ld' | 'microdata' | 'css' | 'slug';

export interface TrustpilotResult {
  trustpilot_url: string;
  domain: string | null;
  rating: number | null;
  domain_source: DomainSource;
}

export function parseTrustpilotPage(html: string, url: string): TrustpilotResult {
  const $ = cheerio.load(html);

  // Method 1: JSON-LD
  const jsonLdResult = extractFromJsonLd($, url);
  if (jsonLdResult) return jsonLdResult;

  // Method 2: Microdata / data attributes
  const microdataResult = extractFromMicrodata($, url);
  if (microdataResult) return microdataResult;

  // Method 3: CSS selectors
  const cssResult = extractFromCss($, url);
  if (cssResult) return cssResult;

  // Method 4: Slug inference
  return extractFromSlug(url);
}

function extractFromJsonLd($: cheerio.CheerioAPI, url: string): TrustpilotResult | null {
  const scripts = $('script[type="application/ld+json"]');
  for (const el of scripts.toArray()) {
    try {
      const raw = $(el).html() ?? '';
      const data = JSON.parse(raw);
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (entry['@type'] === 'Organization' || entry['@type'] === 'LocalBusiness') {
          const websiteUrl = entry.url ?? entry.sameAs?.[0] ?? '';
          const domain = normalizeDomain(websiteUrl);
          const rating = normalizeRating(entry.aggregateRating?.ratingValue);
          if (domain) {
            return { trustpilot_url: url, domain, rating, domain_source: 'json_ld' };
          }
        }
      }
    } catch {
      // malformed JSON, skip
    }
  }
  return null;
}

function extractFromMicrodata($: cheerio.CheerioAPI, url: string): TrustpilotResult | null {
  // Try aria-label on star rating
  const ratingLabel = $('[aria-label]').filter((_, el) => {
    return /rated\s+[\d.]+\s+out\s+of/i.test($(el).attr('aria-label') ?? '');
  }).first().attr('aria-label') ?? '';

  const ratingMatch = ratingLabel.match(/rated\s+([\d.]+)\s+out\s+of/i);
  const rating = ratingMatch ? normalizeRating(ratingMatch[1]) : null;

  // Try "Visit website" link
  const visitLink = $('a[href]').filter((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().toLowerCase();
    return text.includes('visit') && !href.includes('trustpilot.com');
  }).first().attr('href') ?? '';

  const domain = visitLink ? normalizeDomain(visitLink) : null;

  if (domain) {
    return { trustpilot_url: url, domain, rating, domain_source: 'microdata' };
  }

  // Also try data-rating attribute
  const dataRating = $('[data-rating]').first().attr('data-rating');
  const dataRatingVal = dataRating ? normalizeRating(dataRating) : null;
  if (dataRatingVal !== null) {
    // Still need domain
    const externalLink = $('a[href^="http"]').filter((_, el) => {
      const href = $(el).attr('href') ?? '';
      return !href.includes('trustpilot.com') && !href.includes('javascript:');
    }).first().attr('href');
    const extDomain = externalLink ? normalizeDomain(externalLink) : null;
    if (extDomain) {
      return { trustpilot_url: url, domain: extDomain, rating: dataRatingVal, domain_source: 'microdata' };
    }
  }

  return null;
}

function extractFromCss($: cheerio.CheerioAPI, url: string): TrustpilotResult | null {
  const ratingText = $('[class*="star"], [class*="rating"], [class*="Score"]').first().text().trim();
  const ratingMatch = ratingText.match(/([\d.]+)/);
  const rating = ratingMatch ? normalizeRating(ratingMatch[1]) : null;

  const externalLinks = $('a[href^="http"]').toArray()
    .map(el => $(el).attr('href') ?? '')
    .filter(href => !href.includes('trustpilot.com'));

  for (const href of externalLinks) {
    const domain = normalizeDomain(href);
    if (domain) {
      return { trustpilot_url: url, domain, rating, domain_source: 'css' };
    }
  }

  return null;
}

function extractFromSlug(url: string): TrustpilotResult {
  const slug = slugFromUrl(url);
  const domain = slug ? normalizeDomain(slug) : null;
  logger.debug({ url, domain }, 'Using slug fallback for domain extraction');
  return { trustpilot_url: url, domain, rating: null, domain_source: 'slug' };
}
