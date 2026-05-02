import { describe, it, expect } from 'vitest';
import { extractEmails } from '../src/utils/validators.js';

describe('extractEmails — obfuscation decoding', () => {
  it('decodes HTML entity &#64; for @', () => {
    const emails = extractEmails('Contact us at info&#64;example.com');
    expect(emails).toContain('info@example.com');
  });

  it('decodes hex entity &#x40; for @', () => {
    const emails = extractEmails('Reach us: hello&#x40;company.org');
    expect(emails).toContain('hello@company.org');
  });

  it('decodes [at] obfuscation', () => {
    const emails = extractEmails('Email: sales [at] mycompany.co.uk');
    expect(emails).toContain('sales@mycompany.co.uk');
  });

  it('decodes (at) obfuscation', () => {
    const emails = extractEmails('Write to support (at) acme.com');
    expect(emails).toContain('support@acme.com');
  });

  it('decodes AT obfuscation (uppercase)', () => {
    const emails = extractEmails('admin AT example.net');
    expect(emails).toContain('admin@example.net');
  });

  it('decodes &#46; for dot', () => {
    const emails = extractEmails('contact&#64;my&#46;company&#46;com');
    expect(emails).toContain('contact@my.company.com');
  });

  it('handles normal emails without decoding interference', () => {
    const emails = extractEmails('Normal email: user@domain.com');
    expect(emails).toContain('user@domain.com');
  });

  it('deduplicates decoded emails', () => {
    const emails = extractEmails('info&#64;test.com info@test.com');
    expect(emails).toHaveLength(1);
    expect(emails[0]).toBe('info@test.com');
  });
});
