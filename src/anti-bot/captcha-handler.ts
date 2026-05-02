// Cloudflare-specific markers that appear in challenge pages
const CF_MARKERS = ['cf-ray', 'cf-chl-', '_cf_chl_opt', 'cdn-cgi', 'cf_chl_opt'];

// Multilingual challenge keywords (Cloudflare, hCaptcha, reCAPTCHA)
const CHALLENGE_KEYWORDS = [
  // English
  'verify you are human', 'prove you are not a robot', 'just a moment',
  'hcaptcha', 'recaptcha', 'challenge-platform', 'cf-browser-verification',
  'turnstile',
  // French
  'vérifiez que vous êtes humain', 'vérifiez',
  // German
  'bestätigen sie', 'bestätigen',
  // Italian
  'verifica di essere umano', 'verifica',
  // Russian
  'проверка', 'подтвердите',
  // Spanish
  'verificar que eres humano',
];

// Phrases that indicate a deleted/unavailable Trustpilot profile (not a bot challenge)
const DELETED_PROFILE_MARKERS = [
  'business not found', 'no longer exists', 'this page does not exist',
  'profile has been removed', 'company not found',
];

export type CaptchaResult = 'captcha' | 'deleted' | 'blocked' | null;

export function classifyCaptchaResponse(html: string, statusCode: number): CaptchaResult {
  const lower = html.toLowerCase();

  // 403 with Cloudflare markers → captcha challenge
  if (statusCode === 403 && html.length < 50_000) {
    const hasCloudflare = CF_MARKERS.some(m => lower.includes(m));
    if (hasCloudflare) return 'captcha';
  }

  // Explicit challenge keywords regardless of status
  const hasChallengeKeywords = CHALLENGE_KEYWORDS.some(k => lower.includes(k));
  if (hasChallengeKeywords && html.length < 10_000) return 'captcha';

  // hCaptcha/reCAPTCHA iframe (both single and double quoted src)
  if (/<iframe[^>]+src=["'][^"']*captcha/i.test(html)) return 'captcha';

  // 403 with small body but NO Cloudflare markers — likely deleted profile
  if (statusCode === 403 && html.length < 5_000) {
    const isDeleted = DELETED_PROFILE_MARKERS.some(m => lower.includes(m));
    if (isDeleted) return 'deleted';
    // Small 403 body without Cloudflare markers: treat as blocked (not captcha)
    return 'blocked';
  }

  return null;
}

export function isCaptchaPage(html: string, statusCode: number): boolean {
  return classifyCaptchaResponse(html, statusCode) === 'captcha';
}

export function isDeletedProfile(html: string, statusCode: number): boolean {
  return classifyCaptchaResponse(html, statusCode) === 'deleted';
}

export function isBlockedResponse(statusCode: number, html: string): boolean {
  if (statusCode === 429) return false;
  if (statusCode === 403) return true;
  if (statusCode >= 400 && statusCode < 500 && html.length < 1000) return true;
  return false;
}
