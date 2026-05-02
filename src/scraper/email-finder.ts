import * as cheerio from 'cheerio';
import { fetchExternal } from './request.js';
import { extractEmails, filterEmails, rankEmails } from '../utils/validators.js';
import { rateLimiter } from '../anti-bot/rate-limiter.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';

const CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/impressum', '/imprint'];
const FIND_EMAIL_TIMEOUT_MS = 60_000;

function extractEmailsFromHtml(html: string, domain: string): string[] {
  const $ = cheerio.load(html);

  // JSON-LD structured data
  const jsonLdEmails: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() ?? '');
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (entry.email) jsonLdEmails.push(...extractEmails(entry.email));
        if (entry.contactPoint?.email) jsonLdEmails.push(...extractEmails(entry.contactPoint.email));
      }
    } catch {/* skip malformed JSON-LD */}
  });

  // mailto: href links
  const mailtoEmails: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const email = href.replace(/^mailto:/i, '').split('?')[0]?.trim() ?? '';
    if (email) mailtoEmails.push(email.toLowerCase());
  });

  // Regex on decoded visible text only — avoids re-injecting HTML entities
  // that are already decoded in the raw HTML (e.g. &#64; in a JS string).
  const bodyText = $.text();
  const regexEmails = extractEmails(bodyText);

  const all = [...new Set([...jsonLdEmails, ...mailtoEmails, ...regexEmails])];
  const filtered = filterEmails(all, domain);
  return rankEmails(filtered);
}

export async function findEmail(domain: string): Promise<{ email: string | null; status: string }> {
  // Hard 60-second budget per domain regardless of how many pages are tried
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, FIND_EMAIL_TIMEOUT_MS);

  try {
    await rateLimiter.throttleDomain(domain);

    let workingScheme: string | null = null;

    // Try homepage — continue to contact pages even on non-2xx
    // (only give up on DNS / TLS / network failure)
    for (const scheme of ['https://', 'http://']) {
      if (timedOut) break;
      try {
        const { html, statusCode } = await fetchExternal(`${scheme}${domain}`);
        if (statusCode >= 200 && statusCode < 300) {
          workingScheme = scheme;
          const emails = extractEmailsFromHtml(html, domain);
          if (emails.length > 0) return { email: emails[0]!, status: 'done_tier1' };
          break; // homepage loaded OK but no email; try contact pages
        }
        // Non-2xx homepage: still try contact pages with this scheme
        workingScheme = scheme;
        break;
      } catch (err) {
        logger.debug({ domain, scheme, err: String(err) }, 'Homepage fetch failed');
        // Try the next scheme (http fallback)
      }
    }

    if (!workingScheme) {
      // Both schemes failed with a network error
      return { email: null, status: 'not_found_tier1' };
    }

    // Try contact pages using the scheme that worked (or https if homepage returned non-2xx)
    const baseScheme = workingScheme;
    for (const contactPath of CONTACT_PATHS) {
      if (timedOut) break;
      await rateLimiter.throttleDomain(domain);
      try {
        const { html, statusCode } = await fetchExternal(`${baseScheme}${domain}${contactPath}`);
        if (statusCode >= 200 && statusCode < 300) {
          const emails = extractEmailsFromHtml(html, domain);
          if (emails.length > 0) {
            logger.debug({ domain, path: contactPath, email: emails[0] }, 'Email found on contact page');
            return { email: emails[0]!, status: 'done_tier1' };
          }
        }
      } catch (err) {
        logger.debug({ domain, path: contactPath, err: String(err) }, 'Contact page fetch failed');
      }
    }

    return { email: null, status: 'not_found_tier1' };
  } finally {
    clearTimeout(timer);
  }
}
