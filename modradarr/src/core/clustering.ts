import { extractDomain } from './diff-engine';

export type ModqueueItem = {
  thingId: string;
  type: 'post' | 'comment';
  authorId: string;
  authorName: string;
  permalink: string;
  urls: string[];
  createdAt: string;
  bodyPreview: string;
  riskHint?: number;
};

export type ClusterReason = 'domain' | 'author' | 'timewindow' | 'shape';

export type Cluster = {
  id: string;
  reason: ClusterReason;
  label: string;
  items: ModqueueItem[];
  riskScore: number;
  summary: string;
  detectedAt: string;
};

export type ClusterOptions = {
  minGroupSize: number;
  timeWindowMinutes: number;
};

const DEFAULT_OPTIONS: ClusterOptions = {
  minGroupSize: 3,
  timeWindowMinutes: 10,
};

export function clusterItems(
  items: ModqueueItem[],
  options: Partial<ClusterOptions> = {}
): Cluster[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const seen = new Set<string>();
  const all: Cluster[] = [];

  for (const c of byDomain(items, opts)) {
    if (registerCluster(c, seen)) all.push(c);
  }
  for (const c of byAuthor(items, opts)) {
    if (registerCluster(c, seen)) all.push(c);
  }
  for (const c of byTimeWindow(items, opts)) {
    if (registerCluster(c, seen)) all.push(c);
  }

  return all.sort((a, b) => b.riskScore - a.riskScore);
}

function registerCluster(cluster: Cluster, seen: Set<string>): boolean {
  const fingerprint = `${cluster.reason}:${cluster.items
    .map((i) => i.thingId)
    .sort()
    .join(',')}`;
  if (seen.has(fingerprint)) return false;
  seen.add(fingerprint);
  return true;
}

function byDomain(items: ModqueueItem[], opts: ClusterOptions): Cluster[] {
  const byDom = new Map<string, ModqueueItem[]>();
  for (const item of items) {
    const domains = new Set<string>();
    for (const url of item.urls) {
      const d = extractDomain(url);
      if (d) domains.add(d);
    }
    for (const d of domains) {
      const group = byDom.get(d) ?? [];
      group.push(item);
      byDom.set(d, group);
    }
  }

  const clusters: Cluster[] = [];
  for (const [domain, group] of byDom) {
    const unique = dedupe(group);
    if (unique.length < opts.minGroupSize) continue;
    const score = computeRisk(unique);
    clusters.push({
      id: makeId('domain', domain, unique),
      reason: 'domain',
      label: domain,
      items: unique,
      riskScore: score,
      summary: `${unique.length} items linking to ${domain}`,
      detectedAt: new Date().toISOString(),
    });
  }
  return clusters;
}

function byAuthor(items: ModqueueItem[], opts: ClusterOptions): Cluster[] {
  const byAuth = new Map<string, ModqueueItem[]>();
  for (const item of items) {
    if (!item.authorId || item.authorId === '[deleted]') continue;
    const group = byAuth.get(item.authorId) ?? [];
    group.push(item);
    byAuth.set(item.authorId, group);
  }
  const clusters: Cluster[] = [];
  for (const [authorId, group] of byAuth) {
    const unique = dedupe(group);
    if (unique.length < opts.minGroupSize) continue;
    const score = computeRisk(unique);
    const authorName = unique[0]?.authorName ?? authorId;
    clusters.push({
      id: makeId('author', authorId, unique),
      reason: 'author',
      label: `u/${authorName}`,
      items: unique,
      riskScore: score,
      summary: `${unique.length} items from u/${authorName} in recent window`,
      detectedAt: new Date().toISOString(),
    });
  }
  return clusters;
}

function byTimeWindow(items: ModqueueItem[], opts: ClusterOptions): Cluster[] {
  const sorted = [...items].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  const windowMs = opts.timeWindowMinutes * 60 * 1000;
  const clusters: Cluster[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    if (!anchor || consumed.has(anchor.thingId)) continue;
    const anchorTime = Date.parse(anchor.createdAt);
    if (!Number.isFinite(anchorTime)) continue;

    const window: ModqueueItem[] = [anchor];
    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j];
      if (!candidate) continue;
      const t = Date.parse(candidate.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t - anchorTime > windowMs) break;
      window.push(candidate);
    }

    if (window.length < opts.minGroupSize) continue;

    const sharedDomain = findSharedDomain(window);
    if (!sharedDomain) continue;
    const sharing = window.filter((item) =>
      item.urls.some((u) => extractDomain(u) === sharedDomain)
    );
    if (sharing.length < opts.minGroupSize) continue;

    for (const item of sharing) consumed.add(item.thingId);
    const score = computeRisk(sharing);
    clusters.push({
      id: makeId('timewindow', sharedDomain, sharing),
      reason: 'timewindow',
      label: `${sharedDomain} · ${opts.timeWindowMinutes}m burst`,
      items: sharing,
      riskScore: Math.min(1, score + 0.15),
      summary: `${sharing.length} items posted within ${opts.timeWindowMinutes} min all linking to ${sharedDomain}`,
      detectedAt: new Date().toISOString(),
    });
  }
  return clusters;
}

function findSharedDomain(items: ModqueueItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const domains = new Set<string>();
    for (const url of item.urls) {
      const d = extractDomain(url);
      if (d) domains.add(d);
    }
    for (const d of domains) {
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  let best: { domain: string; count: number } | null = null;
  for (const [domain, count] of counts) {
    if (!best || count > best.count) best = { domain, count };
  }
  return best && best.count >= 2 ? best.domain : null;
}

function dedupe(items: ModqueueItem[]): ModqueueItem[] {
  const seen = new Set<string>();
  const out: ModqueueItem[] = [];
  for (const item of items) {
    if (seen.has(item.thingId)) continue;
    seen.add(item.thingId);
    out.push(item);
  }
  return out;
}

function computeRisk(items: ModqueueItem[]): number {
  let score = 0;
  score += Math.min(0.5, items.length * 0.1);

  let hintTotal = 0;
  let hintCount = 0;
  for (const item of items) {
    if (typeof item.riskHint === 'number') {
      hintTotal += item.riskHint;
      hintCount++;
    }
  }
  if (hintCount > 0) {
    score += Math.min(0.4, (hintTotal / hintCount) * 0.6);
  }

  const sorted = [...items]
    .map((i) => Date.parse(i.createdAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (sorted.length >= 2) {
    const first = sorted[0] as number;
    const last = sorted[sorted.length - 1] as number;
    const spanMin = (last - first) / 60000;
    if (spanMin < 10) score += 0.25;
    else if (spanMin < 60) score += 0.1;
  }

  return Math.min(1, Number(score.toFixed(3)));
}

function makeId(reason: string, label: string, items: ModqueueItem[]): string {
  const fingerprint = items
    .map((i) => i.thingId)
    .sort()
    .join(',');
  const safeLabel = label.replace(/[^a-z0-9.-]+/gi, '_').slice(0, 40);
  return `${reason}__${safeLabel}__${hashString(fingerprint)}`;
}

function hashString(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
