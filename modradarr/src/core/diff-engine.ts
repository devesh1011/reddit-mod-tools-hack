import { createHash } from 'node:crypto';

const URL_PATTERN =
  /\bhttps?:\/\/[^\s<>"'`)\]]+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`)\]]*)?/gi;

export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const matches = text.matchAll(URL_PATTERN);
  for (const m of matches) {
    const raw = m[0];
    const candidate = raw.startsWith('http') ? raw : `https://${raw}`;
    try {
      const url = new URL(candidate);
      if (!url.hostname.includes('.')) continue;
      url.hash = '';
      found.add(url.toString());
    } catch {
      continue;
    }
  }
  return [...found];
}

export function extractDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export type UrlDiff = {
  added: string[];
  removed: string[];
};

export function diffUrls(oldUrls: string[], newUrls: string[]): UrlDiff {
  const oldSet = new Set(oldUrls);
  const newSet = new Set(newUrls);
  return {
    added: newUrls.filter((u) => !oldSet.has(u)),
    removed: oldUrls.filter((u) => !newSet.has(u)),
  };
}

export function diffPreview(oldBody: string, newBody: string, max = 280): string {
  const oldTrim = oldBody.length > max ? oldBody.slice(0, max) + '…' : oldBody;
  const newTrim = newBody.length > max ? newBody.slice(0, max) + '…' : newBody;
  return `BEFORE: ${oldTrim}\n\nAFTER: ${newTrim}`;
}

export function isWithinEditWindow(createdAt: string, windowHours: number): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const elapsedHours = (Date.now() - created) / 3_600_000;
  return elapsedHours <= windowHours;
}
