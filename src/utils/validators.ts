const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const NOREPLY_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
];

// Third-party service / placeholder domains — always false positives
const BLOCKED_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'test.com',
  'wixpress.com', 'sentry.io', 'cloudflare.com',
  'domain.tld', 'yourdomain.com', 'email.com',
]);

const PREFERRED_PREFIXES = ['info', 'contact', 'hello', 'support', 'admin', 'sales', 'enquiries', 'enquiry'];

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com',
  'icloud.com', 'protonmail.com', 'live.com', 'msn.com',
]);

function decodeEmailObfuscation(text: string): string {
  return text
    .replace(/&#64;/gi, '@')
    .replace(/&#x40;/gi, '@')
    .replace(/\s+\[at\]\s+/gi, '@')
    .replace(/\s+\(at\)\s+/gi, '@')
    .replace(/\s+AT\s+/g, '@')
    .replace(/＠/g, '@')
    .replace(/&#46;/gi, '.')
    .replace(/\s+\[dot\]\s+/gi, '.')
    .replace(/\s+\(dot\)\s+/gi, '.');
}

export function extractEmails(text: string): string[] {
  const decoded = decodeEmailObfuscation(text);
  const matches = decoded.match(EMAIL_REGEX) ?? [];
  return [...new Set(matches.map(e => e.toLowerCase()))];
}

export function filterEmails(emails: string[], businessDomain: string): string[] {
  const isNoreply = (email: string) => NOREPLY_PATTERNS.some(p => p.test(email));

  const businessEmails = emails.filter(email => {
    if (isNoreply(email)) return false;
    const [, emailDomain] = email.split('@');
    if (!emailDomain) return false;
    if (BLOCKED_EMAIL_DOMAINS.has(emailDomain)) return false;
    if (FREEMAIL_DOMAINS.has(emailDomain)) return false;
    return emailDomain === businessDomain || emailDomain.endsWith('.' + businessDomain);
  });

  if (businessEmails.length > 0) return businessEmails;

  // Tier-2 fallback: accept freemail only if no business-domain email was found
  return emails.filter(email => {
    if (isNoreply(email)) return false;
    const [, emailDomain] = email.split('@');
    if (!emailDomain) return false;
    if (BLOCKED_EMAIL_DOMAINS.has(emailDomain)) return false;
    return FREEMAIL_DOMAINS.has(emailDomain);
  });
}

export function rankEmails(emails: string[]): string[] {
  return [...emails].sort((a, b) => {
    const [aPrefix] = a.split('@');
    const [bPrefix] = b.split('@');
    const aRank = PREFERRED_PREFIXES.indexOf(aPrefix ?? '') === -1
      ? PREFERRED_PREFIXES.length
      : PREFERRED_PREFIXES.indexOf(aPrefix ?? '');
    const bRank = PREFERRED_PREFIXES.indexOf(bPrefix ?? '') === -1
      ? PREFERRED_PREFIXES.length
      : PREFERRED_PREFIXES.indexOf(bPrefix ?? '');
    return aRank - bRank;
  });
}

export function normalizeDomain(raw: string): string | null {
  try {
    let d = raw.trim().toLowerCase();
    d = d.replace(/^https?:\/\//i, '');
    d = d.replace(/^www\./i, '');
    d = d.replace(/\/.*$/, '');
    d = d.replace(/\?.*$/, '');
    d = d.replace(/#.*$/, '');
    if (!d.includes('.') || d.includes(' ')) return null;
    return d;
  } catch {
    return null;
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

export function normalizeRating(raw: unknown): number | null {
  const n = parseFloat(String(raw));
  if (isNaN(n) || n < 1.0 || n > 5.0) return null;
  return Math.round(n * 10) / 10;
}

export function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

export function slugFromUrl(url: string): string | null {
  const m = url.match(/trustpilot\.com\/(?:[a-z]{2}\/)?review\/([^\s/?#]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}
