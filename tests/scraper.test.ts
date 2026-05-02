import { describe, it, expect } from 'vitest';
import { parseTrustpilotPage } from '../src/scraper/trustpilot.js';
import { isCaptchaPage, classifyCaptchaResponse } from '../src/anti-bot/captcha-handler.js';
import { extractEmails, filterEmails, rankEmails, normalizeDomain, normalizeRating } from '../src/utils/validators.js';

const SAMPLE_JSONLD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">
  {
    "@context": "http://schema.org",
    "@type": "Organization",
    "name": "Example Company",
    "url": "https://www.example.com",
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": "4.2",
      "reviewCount": "1234"
    }
  }
  </script>
</head>
<body><h1>Example Company</h1></body>
</html>
`;

const SAMPLE_NO_JSONLD_HTML = `
<!DOCTYPE html>
<html>
<body>
  <a href="https://www.mysite.co.uk/" target="_blank" rel="noopener">Visit website</a>
  <div aria-label="Rated 3.7 out of 5 stars" class="star-rating"></div>
</body>
</html>
`;

const CAPTCHA_HTML = `
<html>
<head><title>Just a moment...</title></head>
<body>
  <div>Verify you are human</div>
  <script>window._cf_chl_opt={}</script>
</body>
</html>
`;

describe('Trustpilot page parser — JSON-LD', () => {
  const url = 'https://www.trustpilot.com/review/example.com';

  it('extracts domain from JSON-LD', () => {
    const result = parseTrustpilotPage(SAMPLE_JSONLD_HTML, url);
    expect(result.domain).toBe('example.com');
    expect(result.domain_source).toBe('json_ld');
  });

  it('extracts rating from JSON-LD', () => {
    const result = parseTrustpilotPage(SAMPLE_JSONLD_HTML, url);
    expect(result.rating).toBe(4.2);
  });

  it('returns the correct trustpilot_url', () => {
    const result = parseTrustpilotPage(SAMPLE_JSONLD_HTML, url);
    expect(result.trustpilot_url).toBe(url);
  });
});

describe('Trustpilot page parser — fallback', () => {
  it('falls back to microdata when no JSON-LD', () => {
    const result = parseTrustpilotPage(SAMPLE_NO_JSONLD_HTML, 'https://www.trustpilot.com/review/mysite.co.uk');
    expect(result.domain).toBeTruthy();
  });

  it('falls back to slug when all else fails', () => {
    const result = parseTrustpilotPage('<html><body>Nothing</body></html>', 'https://www.trustpilot.com/review/fallback-brand.com');
    expect(result.domain_source).toBe('slug');
    expect(result.domain).toBe('fallback-brand.com');
  });
});

describe('Captcha detection', () => {
  it('detects Cloudflare challenge page', () => {
    expect(isCaptchaPage(CAPTCHA_HTML, 403)).toBe(true);
  });

  it('does not flag normal pages', () => {
    expect(isCaptchaPage(SAMPLE_JSONLD_HTML, 200)).toBe(false);
  });

  it('classifies short 403 without CF markers as blocked (not captcha)', () => {
    // H11: Small 403 body without Cloudflare markers = generic block, not captcha.
    // isCaptchaPage returns false; classifyCaptchaResponse returns 'blocked'.
    const short = '<html><body>Access denied. Blocked by bot protection.</body></html>';
    expect(isCaptchaPage(short, 403)).toBe(false);
    expect(classifyCaptchaResponse(short, 403)).toBe('blocked');
  });
});

describe('Email extraction', () => {
  it('extracts emails from text', () => {
    const emails = extractEmails('Contact us at info@example.com or support@example.com');
    expect(emails).toContain('info@example.com');
    expect(emails).toContain('support@example.com');
  });

  it('handles encoded emails', () => {
    const emails = extractEmails('Email: hello@my-company.co.uk for inquiries');
    expect(emails).toContain('hello@my-company.co.uk');
  });

  it('deduplicates emails', () => {
    const emails = extractEmails('info@test.com info@test.com info@test.com');
    expect(emails).toHaveLength(1);
  });
});

describe('Email filtering', () => {
  it('filters noreply emails', () => {
    const filtered = filterEmails(['noreply@mycompany.com', 'info@mycompany.com'], 'mycompany.com');
    expect(filtered).not.toContain('noreply@mycompany.com');
    expect(filtered).toContain('info@mycompany.com');
  });

  it('filters no-reply emails', () => {
    const filtered = filterEmails(['no-reply@mybusiness.co', 'contact@mybusiness.co'], 'mybusiness.co');
    expect(filtered).not.toContain('no-reply@mybusiness.co');
  });

  it('keeps gmail addresses for small businesses', () => {
    const filtered = filterEmails(['owner@gmail.com'], 'mybusiness.com');
    expect(filtered).toContain('owner@gmail.com');
  });

  it('filters out unrelated domain emails', () => {
    const filtered = filterEmails(['admin@other-company.com'], 'mybusiness.com');
    expect(filtered).not.toContain('admin@other-company.com');
  });
});

describe('Email ranking', () => {
  it('ranks info@ first', () => {
    const ranked = rankEmails(['support@x.com', 'info@x.com', 'admin@x.com']);
    expect(ranked[0]).toBe('info@x.com');
  });

  it('ranks contact@ second', () => {
    const ranked = rankEmails(['admin@x.com', 'contact@x.com']);
    expect(ranked[0]).toBe('contact@x.com');
  });
});

describe('Domain normalization', () => {
  it('strips https and www', () => {
    expect(normalizeDomain('https://www.example.com/')).toBe('example.com');
  });

  it('strips trailing slash', () => {
    expect(normalizeDomain('example.com/')).toBe('example.com');
  });

  it('lowercases', () => {
    expect(normalizeDomain('EXAMPLE.COM')).toBe('example.com');
  });

  it('returns null for invalid domains', () => {
    expect(normalizeDomain('not a domain')).toBeNull();
  });
});

describe('Rating normalization', () => {
  it('parses valid ratings', () => {
    expect(normalizeRating('4.2')).toBe(4.2);
    expect(normalizeRating(3.8)).toBe(3.8);
    expect(normalizeRating('5')).toBe(5.0);
    expect(normalizeRating('1')).toBe(1.0);
  });

  it('returns null for out-of-range ratings', () => {
    expect(normalizeRating(0)).toBeNull();
    expect(normalizeRating(5.5)).toBeNull();
    expect(normalizeRating(-1)).toBeNull();
  });

  it('returns null for non-numeric values', () => {
    expect(normalizeRating('abc')).toBeNull();
    expect(normalizeRating(null)).toBeNull();
    expect(normalizeRating(undefined)).toBeNull();
  });
});
