import { describe, it, expect } from 'vitest';
import { parseRobots, isDisallowed } from '../src/anti-bot/robots.js';

describe('parseRobots', () => {
  it('extracts Disallow rules only under User-agent: *', () => {
    const body = `
User-agent: Googlebot
Disallow: /private/

User-agent: *
Disallow: /review/
Disallow: /categories/

Sitemap: https://www.trustpilot.com/sitemap_index.xml
`;
    const rules = parseRobots(body);
    expect(rules.disallow).toEqual(['/review/', '/categories/']);
    expect(rules.sitemap).toBe('https://www.trustpilot.com/sitemap_index.xml');
  });

  it('ignores empty Disallow values (meaning allow all)', () => {
    const body = `
User-agent: *
Disallow:
Disallow:
Disallow: /secret/
`;
    const rules = parseRobots(body);
    expect(rules.disallow).toEqual(['/secret/']);
  });

  it('returns null sitemap when no Sitemap directive is present', () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /admin/\n`);
    expect(rules.sitemap).toBeNull();
  });

  it('ignores comment lines and blank lines', () => {
    const body = `# Comment\nUser-agent: *\n# Another comment\n\nDisallow: /test/\n`;
    const rules = parseRobots(body);
    expect(rules.disallow).toEqual(['/test/']);
  });
});

describe('isDisallowed', () => {
  const rules = { sitemap: null, disallow: ['/review/', '/admin/'] };

  it('returns true for paths matching a Disallow prefix', () => {
    expect(isDisallowed('/review/amazon.com', rules)).toBe(true);
    expect(isDisallowed('/admin/panel', rules)).toBe(true);
  });

  it('returns false for paths outside any Disallow prefix', () => {
    expect(isDisallowed('/categories/', rules)).toBe(false);
    expect(isDisallowed('/profile/', rules)).toBe(false);
  });

  it('returns false when disallow list is empty', () => {
    expect(isDisallowed('/review/foo', { sitemap: null, disallow: [] })).toBe(false);
  });

  it('Disallow: / blocks all paths', () => {
    expect(isDisallowed('/review/foo', { sitemap: null, disallow: ['/'] })).toBe(true);
    expect(isDisallowed('/categories/tech', { sitemap: null, disallow: ['/'] })).toBe(true);
  });
});
