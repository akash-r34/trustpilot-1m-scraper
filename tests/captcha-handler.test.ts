import { describe, it, expect } from 'vitest';
import { isCaptchaPage, isDeletedProfile, classifyCaptchaResponse } from '../src/anti-bot/captcha-handler.js';

const CLOUDFLARE_PAGE = `
<html>
<head><title>Just a moment...</title></head>
<body>
  <script>window._cf_chl_opt={}</script>
  <div>Please verify you are human</div>
</body>
</html>`;

const DELETED_PROFILE_PAGE = `
<html>
<body><p>Business not found. This profile has been removed from Trustpilot.</p></body>
</html>`;

const NORMAL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Acme Corp — Trustpilot</title></head>
<body><h1>Acme Corp</h1><p>4.5 stars</p></body>
</html>`;

const HCAPTCHA_PAGE = `
<html>
<body>
  <script src="https://hcaptcha.com/1/api.js"></script>
  <div class="h-captcha" data-sitekey="abc"></div>
</body>
</html>`;

describe('Captcha detection — Cloudflare', () => {
  it('detects Cloudflare challenge page (403 + _cf_chl_opt marker)', () => {
    expect(isCaptchaPage(CLOUDFLARE_PAGE, 403)).toBe(true);
  });

  it('detects hCaptcha page via keyword', () => {
    expect(isCaptchaPage(HCAPTCHA_PAGE, 200)).toBe(true);
  });

  it('does not flag normal 200 pages', () => {
    expect(isCaptchaPage(NORMAL_PAGE, 200)).toBe(false);
  });

  it('does not flag 403 with large body and no CF markers as captcha', () => {
    const bigNormalPage = '<html><body>' + 'x'.repeat(6000) + '</body></html>';
    expect(isCaptchaPage(bigNormalPage, 403)).toBe(false);
  });
});

describe('Deleted profile detection', () => {
  it('classifies 403 with "business not found" as deleted, not captcha', () => {
    expect(classifyCaptchaResponse(DELETED_PROFILE_PAGE, 403)).toBe('deleted');
  });

  it('isDeletedProfile returns true for deleted page', () => {
    expect(isDeletedProfile(DELETED_PROFILE_PAGE, 403)).toBe(true);
  });

  it('isCaptchaPage returns false for deleted page', () => {
    expect(isCaptchaPage(DELETED_PROFILE_PAGE, 403)).toBe(false);
  });
});

describe('CAPTCHA iframe detection', () => {
  it('detects captcha iframe with double-quoted src', () => {
    const html = '<html><body><iframe src="https://captcha.example.com/frame"></iframe></body></html>';
    expect(isCaptchaPage(html, 200)).toBe(true);
  });

  it('detects captcha iframe with single-quoted src', () => {
    const html = "<html><body><iframe src='https://captcha.example.com/frame'></iframe></body></html>";
    expect(isCaptchaPage(html, 200)).toBe(true);
  });
});

describe('Multilingual challenge detection', () => {
  it('detects German challenge keyword', () => {
    const html = '<html><body><p>Bitte bestätigen Sie, dass Sie ein Mensch sind.</p></body></html>';
    // Must be a short page to trigger the keyword heuristic
    expect(isCaptchaPage(html, 403)).toBe(true);
  });

  it('detects Russian challenge keyword', () => {
    const html = '<html><body><p>проверка</p></body></html>';
    expect(isCaptchaPage(html, 403)).toBe(true);
  });
});
