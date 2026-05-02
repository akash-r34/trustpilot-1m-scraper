import fs from 'fs';
import { config } from '../config.js';

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.8',
  'de-DE,de;q=0.9,en;q=0.8',
  'fr-FR,fr;q=0.9,en;q=0.8',
  'es-ES,es;q=0.9,en;q=0.8',
];

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.com/search?q=trustpilot',
  'https://www.trustpilot.com/',
  '',
];

// Browser fingerprint bundles — headers must be internally consistent with the UA
const BROWSER_BUNDLES: Array<{ uaHint: RegExp; secHeaders: Record<string, string> }> = [
  {
    // Chrome on Windows/Mac/Linux
    uaHint: /Chrome\/(\d+).*(?:Windows|Macintosh|Linux)/,
    secHeaders: {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
  },
  {
    // Firefox
    uaHint: /Firefox\/(\d+)/,
    secHeaders: {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'no-cache',
    },
  },
  {
    // Safari
    uaHint: /Safari\/[\d.]+ (?!Chrome)/,
    secHeaders: {
      'Cache-Control': 'max-age=0',
    },
  },
];

const FALLBACK_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

let userAgents: string[] = [];

function loadUserAgents(): void {
  if (userAgents.length > 0) return;
  try {
    const content = fs.readFileSync(config.userAgentsFile, 'utf-8');
    userAgents = content.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    userAgents = FALLBACK_UAS;
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function getBundleForUA(ua: string): Record<string, string> {
  for (const bundle of BROWSER_BUNDLES) {
    if (bundle.uaHint.test(ua)) return bundle.secHeaders;
  }
  return BROWSER_BUNDLES[0]!.secHeaders; // default to Chrome bundle
}

export function getRandomHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  loadUserAgents();
  const ua = pick(userAgents.length > 0 ? userAgents : FALLBACK_UAS);
  const referer = pick(REFERERS);
  const secHeaders = getBundleForUA(ua);

  const headers: Record<string, string> = {
    'User-Agent': ua,
    'Accept': ACCEPT,
    'Accept-Language': pick(ACCEPT_LANGUAGES),
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
    ...secHeaders,
    ...extraHeaders,
  };
  if (referer) headers['Referer'] = referer;
  return headers;
}
