import { redis, settings } from '@devvit/web/server';
import { bumpDomainReport, getDomainReportCount } from './redis-schema';
import { extractDomain } from './diff-engine';

const RESOLVED_CACHE_TTL_SECONDS = 24 * 60 * 60;
const SAFEBROWSE_CACHE_TTL_SECONDS = 6 * 60 * 60;
const MAX_REDIRECT_HOPS = 3;
const FETCH_TIMEOUT_MS = 4000;

const SHORTENERS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'ow.ly',
  'goo.gl',
  'is.gd',
  'buff.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  'tiny.cc',
  's.id',
  'rebrand.ly',
  'lnkd.in',
  'youtu.be',
  'trib.al',
]);

const SUSPICIOUS_TLDS = new Set([
  'xyz',
  'top',
  'click',
  'gq',
  'cf',
  'ml',
  'tk',
  'ga',
  'work',
  'fit',
  'rest',
  'mom',
  'lol',
  'bond',
  'cyou',
  'sbs',
  'cam',
  'icu',
  'live',
]);

const TRUSTED_DOMAINS = new Set([
  'reddit.com',
  'redd.it',
  'imgur.com',
  'wikipedia.org',
  'youtube.com',
  'github.com',
  'stackoverflow.com',
  'twitter.com',
  'x.com',
  'medium.com',
]);

export type UrlScore = {
  url: string;
  resolvedUrl: string;
  domain: string;
  score: number;
  signals: string[];
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHeadLocation(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal,
    });
    const location = res.headers.get('location');
    if (location) return new URL(location, url).toString();
    if (res.status >= 200 && res.status < 400) return null;
    return null;
  } catch {
    return null;
  }
}

async function resolveOnce(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const location = await fetchHeadLocation(url, controller.signal);
    return location;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveUrl(url: string): Promise<string> {
  const initialDomain = extractDomain(url);
  if (!initialDomain || !SHORTENERS.has(initialDomain)) return url;

  const cacheKey = `mr:cache:resolved:${url}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  let current = url;
  const seen = new Set<string>([url]);
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const domain = extractDomain(current);
    if (!domain || !SHORTENERS.has(domain)) break;
    const next = await resolveOnce(current);
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }

  await redis.set(cacheKey, current);
  await redis.expire(cacheKey, RESOLVED_CACHE_TTL_SECONDS);
  return current;
}

type SafeBrowsingMatch = { threatType: string };

async function checkSafeBrowsing(url: string): Promise<SafeBrowsingMatch | null> {
  const apiKey = await settings.get<string>('safeBrowsingApiKey').catch(() => undefined);
  if (!apiKey) return null;

  const cacheKey = `mr:cache:sb:${url}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    if (cached === 'safe') return null;
    return { threatType: cached };
  }

  const body = {
    client: { clientId: 'modradar', clientVersion: '1.0.0' },
    threatInfo: {
      threatTypes: [
        'MALWARE',
        'SOCIAL_ENGINEERING',
        'UNWANTED_SOFTWARE',
        'POTENTIALLY_HARMFUL_APPLICATION',
      ],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: [{ url }],
    },
  };

  const result = await withTimeout(
    fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    ).then((r) => (r.ok ? r.json() : null)),
    FETCH_TIMEOUT_MS
  );

  if (!result || typeof result !== 'object') {
    return null;
  }
  const matches = (result as { matches?: SafeBrowsingMatch[] }).matches;
  if (!matches || matches.length === 0) {
    await redis.set(cacheKey, 'safe');
    await redis.expire(cacheKey, SAFEBROWSE_CACHE_TTL_SECONDS);
    return null;
  }
  const match = matches[0]!;
  await redis.set(cacheKey, match.threatType);
  await redis.expire(cacheKey, SAFEBROWSE_CACHE_TTL_SECONDS);
  return match;
}

export async function scoreUrl(url: string): Promise<UrlScore | null> {
  const resolvedUrl = await resolveUrl(url);
  const domain = extractDomain(resolvedUrl);
  if (!domain) return null;
  if (domain.endsWith('.reddit.com') || TRUSTED_DOMAINS.has(domain)) {
    return { url, resolvedUrl, domain, score: 0, signals: ['trusted-domain'] };
  }

  const signals: string[] = [];
  let score = 0;

  if (resolvedUrl !== url) {
    signals.push('resolved-from-shortener');
    score += 0.2;
  }

  const tld = domain.split('.').pop() ?? '';
  if (SUSPICIOUS_TLDS.has(tld)) {
    score += 0.4;
    signals.push(`suspicious-tld:${tld}`);
  }

  const initialDomain = extractDomain(url);
  if (initialDomain && SHORTENERS.has(initialDomain)) {
    score += 0.3;
    signals.push('shortener');
  }

  const labels = domain.split('.');
  const sld = labels.length >= 2 ? labels[labels.length - 2] ?? '' : '';
  if (sld.length >= 14 || /\d{3,}/.test(sld) || /-{2,}/.test(sld)) {
    score += 0.15;
    signals.push('suspicious-shape');
  }

  const priorReports = await getDomainReportCount(domain);
  if (priorReports > 0) {
    const reportSignal = Math.min(0.4, priorReports * 0.1);
    score += reportSignal;
    signals.push(`prior-reports:${priorReports}`);
  }

  const sb = await checkSafeBrowsing(resolvedUrl);
  if (sb) {
    score = Math.max(score, 0.95);
    signals.push(`safebrowsing:${sb.threatType}`);
  }

  if (score === 0) {
    signals.push('unknown-domain');
    score = 0.2;
  }

  return { url, resolvedUrl, domain, score: Math.min(1, score), signals };
}

export async function scoreUrls(urls: string[]): Promise<UrlScore[]> {
  const scores: UrlScore[] = [];
  for (const url of urls) {
    const result = await scoreUrl(url);
    if (result) scores.push(result);
  }
  return scores;
}

export function maxScore(scores: UrlScore[]): number {
  return scores.reduce((max, s) => (s.score > max ? s.score : max), 0);
}

export async function recordReportedDomains(domains: string[]): Promise<void> {
  const seen = new Set<string>();
  for (const domain of domains) {
    if (seen.has(domain)) continue;
    seen.add(domain);
    await bumpDomainReport(domain);
  }
}
