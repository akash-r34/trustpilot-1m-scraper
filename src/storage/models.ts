export interface UrlRecord {
  id: number;
  slug: string;
  trustpilot_url: string;
  status: 'pending' | 'scraping' | 'done' | 'failed' | 'captcha';
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface ResultRecord {
  id: number;
  slug: string;
  trustpilot_url: string;
  domain: string | null;
  rating: number | null;
  email: string | null;
  email_status:
    | 'pending'
    | 'done'
    | 'done_tier1'
    | 'done_tier2'
    | 'done_tier3'
    | 'failed'
    | 'not_found'
    | 'not_found_tier1'
    | 'not_found_tier2'
    | 'not_found_tier3';
  domain_source: 'json_ld' | 'microdata' | 'css' | 'slug';
  scraped_at: string;
}

export interface ScrapeStats {
  pending: number;
  scraping: number;
  done: number;
  failed: number;
  captcha: number;
  total: number;
}

export interface EmailStats {
  tier1: number;
  tier2: number;
  tier3: number;
  total_with_email: number;
  not_found: number;
  pending: number;
}
