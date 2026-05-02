import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractEmails, filterEmails, rankEmails } from '../utils/validators.js';
import { logger } from '../utils/logger.js';

export async function findEmailFirecrawl(domain: string): Promise<{ email: string | null; status: string }> {
  // Use async fs to avoid blocking the event loop
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'firecrawl-'));
  const results: string[] = [];

  try {
    for (const suffix of ['', '/contact', '/contact-us', '/about']) {
      const url = `https://${domain}${suffix}`;
      const outFile = path.join(tmpDir, `page${suffix.replace(/\//g, '_') || '_home'}.md`);

      // spawnSync avoids shell injection — each argument is passed separately
      const result = spawnSync(
        'firecrawl',
        ['scrape', url, '--only-main-content', '-o', outFile],
        { timeout: 30_000, stdio: 'pipe' }
      );

      if (result.error) {
        logger.debug({ domain, url, error: result.error.message }, 'Firecrawl spawn failed');
      }

      try {
        const content = await fs.promises.readFile(outFile, 'utf-8');
        if (content.trim()) results.push(content);
      } catch {/* file may not exist if firecrawl failed */}

      if (results.some(r => r.length > 0)) break;
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {/* ok */});
  }

  const combined = results.join('\n');
  if (!combined.trim()) {
    return { email: null, status: 'not_found_tier2' };
  }

  const emails = rankEmails(filterEmails(extractEmails(combined), domain));
  if (emails.length > 0) {
    logger.debug({ domain, email: emails[0] }, 'Firecrawl email found');
    return { email: emails[0]!, status: 'done_tier2' };
  }

  return { email: null, status: 'not_found_tier2' };
}
