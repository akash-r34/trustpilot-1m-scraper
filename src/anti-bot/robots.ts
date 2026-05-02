import { fetchDirect } from '../scraper/request.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface RobotsRules {
  sitemap: string | null;
  disallow: string[];
}

// Parse robots.txt body. Only captures Disallow entries under User-agent: *
// (case-insensitive). Returns the first Sitemap directive found in any group.
export function parseRobots(body: string): RobotsRules {
  const disallow: string[] = [];
  let sitemap: string | null = null;
  let inWildcardGroup = false;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'user-agent') {
      inWildcardGroup = value === '*';
    } else if (key === 'disallow' && inWildcardGroup && value) {
      disallow.push(value);
    } else if (key === 'sitemap' && !sitemap && value) {
      sitemap = value;
    }
  }

  return { sitemap, disallow };
}

// A URL's pathname is disallowed if it starts with any Disallow prefix.
export function isDisallowed(pathname: string, rules: RobotsRules): boolean {
  return rules.disallow.some(prefix => pathname.startsWith(prefix));
}

// Target path prefixes this scraper hits (used for the startup compliance warning).
const TARGET_PREFIXES = ['/review/', '/categories/', '/uk/review/'];

let _cached: Promise<RobotsRules> | null = null;
let _resolvedRules: RobotsRules | null = null;

export function loadRobots(): Promise<RobotsRules> {
  if (!_cached) {
    _cached = (async () => {
      try {
        const { html } = await fetchDirect('https://www.trustpilot.com/robots.txt');
        _resolvedRules = parseRobots(html);
      } catch (err) {
        logger.warn({ err: String(err) }, 'Could not fetch robots.txt — proceeding without rules');
        _resolvedRules = { sitemap: null, disallow: [] };
      }
      return _resolvedRules!;
    })();
  }
  return _cached;
}

// Synchronous access to the already-resolved rules (null if not yet resolved).
// Safe to call after logRobotsAtStartup() has been awaited.
export function getCachedRules(): RobotsRules | null {
  return _resolvedRules;
}

export async function logRobotsAtStartup(): Promise<void> {
  try {
    const rules = await loadRobots();
    logger.info(
      { disallowCount: rules.disallow.length, respectRobots: config.respectRobots },
      'robots.txt loaded'
    );
    if (rules.disallow.length > 0) {
      logger.debug({ disallow: rules.disallow }, 'Trustpilot robots.txt Disallow list');
    }
    const flaggedPaths = TARGET_PREFIXES.filter(p => isDisallowed(p, rules));
    if (flaggedPaths.length > 0) {
      logger.warn(
        { flaggedPaths, respectRobots: config.respectRobots },
        'Trustpilot robots.txt disallows paths this scraper uses — set RESPECT_ROBOTS=true to enforce'
      );
    }
  } catch {
    // advisory only — never block a command
  }
}
