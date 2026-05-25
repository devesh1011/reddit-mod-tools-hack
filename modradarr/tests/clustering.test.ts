import { describe, expect, it } from 'vitest';
import { clusterItems, type ModqueueItem } from '../src/core/clustering';

function item(overrides: Partial<ModqueueItem>): ModqueueItem {
  return {
    thingId: overrides.thingId ?? `t3_${Math.random().toString(36).slice(2)}`,
    type: overrides.type ?? 'post',
    authorId: overrides.authorId ?? 't2_a',
    authorName: overrides.authorName ?? 'someone',
    permalink: overrides.permalink ?? '',
    urls: overrides.urls ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    bodyPreview: overrides.bodyPreview ?? '',
    ...(overrides.riskHint !== undefined ? { riskHint: overrides.riskHint } : {}),
  };
}

describe('clusterItems', () => {
  it('returns empty when below minGroupSize', () => {
    const items = [
      item({ urls: ['https://bit.ly/a'] }),
      item({ urls: ['https://bit.ly/b'] }),
    ];
    expect(clusterItems(items, { minGroupSize: 3 })).toEqual([]);
  });

  it('groups by shared domain when threshold is met', () => {
    const items = [
      item({ thingId: 't3_1', urls: ['https://bad.example/x'] }),
      item({ thingId: 't3_2', urls: ['https://bad.example/y'] }),
      item({ thingId: 't3_3', urls: ['https://bad.example/z'] }),
    ];
    const clusters = clusterItems(items, { minGroupSize: 3 });
    const domain = clusters.find((c) => c.reason === 'domain');
    expect(domain).toBeDefined();
    expect(domain!.items).toHaveLength(3);
    expect(domain!.label).toBe('bad.example');
  });

  it('groups by shared author', () => {
    const items = [
      item({ thingId: 't3_1', authorId: 't2_spammer', urls: ['https://a.com'] }),
      item({ thingId: 't3_2', authorId: 't2_spammer', urls: ['https://b.com'] }),
      item({ thingId: 't3_3', authorId: 't2_spammer', urls: ['https://c.com'] }),
    ];
    const clusters = clusterItems(items, { minGroupSize: 3 });
    const author = clusters.find((c) => c.reason === 'author');
    expect(author).toBeDefined();
    expect(author!.items).toHaveLength(3);
  });

  it('skips deleted authors when grouping by author', () => {
    const items = [
      item({ thingId: 't3_1', authorId: '[deleted]' }),
      item({ thingId: 't3_2', authorId: '[deleted]' }),
      item({ thingId: 't3_3', authorId: '[deleted]' }),
    ];
    const clusters = clusterItems(items, { minGroupSize: 3 });
    expect(clusters.filter((c) => c.reason === 'author')).toEqual([]);
  });

  it('detects time-window bursts that share a domain', () => {
    const now = Date.now();
    const items = [
      item({
        thingId: 't3_1',
        createdAt: new Date(now).toISOString(),
        urls: ['https://burst.example/1'],
        authorId: 't2_a',
      }),
      item({
        thingId: 't3_2',
        createdAt: new Date(now + 60_000).toISOString(),
        urls: ['https://burst.example/2'],
        authorId: 't2_b',
      }),
      item({
        thingId: 't3_3',
        createdAt: new Date(now + 120_000).toISOString(),
        urls: ['https://burst.example/3'],
        authorId: 't2_c',
      }),
    ];
    const clusters = clusterItems(items, { minGroupSize: 3, timeWindowMinutes: 10 });
    const burst = clusters.find((c) => c.reason === 'timewindow');
    expect(burst).toBeDefined();
    expect(burst!.items).toHaveLength(3);
  });

  it('scores tightly-clustered events higher than spread-out ones', () => {
    const close = [
      item({ thingId: 't3_1', urls: ['https://x.com'], createdAt: '2026-01-01T00:00:00Z' }),
      item({ thingId: 't3_2', urls: ['https://x.com'], createdAt: '2026-01-01T00:01:00Z' }),
      item({ thingId: 't3_3', urls: ['https://x.com'], createdAt: '2026-01-01T00:02:00Z' }),
    ];
    const spread = [
      item({ thingId: 't3_4', urls: ['https://x.com'], createdAt: '2026-01-01T00:00:00Z' }),
      item({ thingId: 't3_5', urls: ['https://x.com'], createdAt: '2026-01-01T12:00:00Z' }),
      item({ thingId: 't3_6', urls: ['https://x.com'], createdAt: '2026-01-02T00:00:00Z' }),
    ];
    const closeCluster = clusterItems(close, { minGroupSize: 3 }).find(
      (c) => c.reason === 'domain'
    )!;
    const spreadCluster = clusterItems(spread, { minGroupSize: 3 }).find(
      (c) => c.reason === 'domain'
    )!;
    expect(closeCluster.riskScore).toBeGreaterThan(spreadCluster.riskScore);
  });

  it('factors riskHint into the cluster score', () => {
    const baseItems = (hint?: number) => [
      item({ thingId: 't3_1', urls: ['https://h.com'], ...(hint !== undefined ? { riskHint: hint } : {}) }),
      item({ thingId: 't3_2', urls: ['https://h.com'], ...(hint !== undefined ? { riskHint: hint } : {}) }),
      item({ thingId: 't3_3', urls: ['https://h.com'], ...(hint !== undefined ? { riskHint: hint } : {}) }),
    ];
    const noHint = clusterItems(baseItems(), { minGroupSize: 3 }).find((c) => c.reason === 'domain')!;
    const withHint = clusterItems(baseItems(0.9), { minGroupSize: 3 }).find(
      (c) => c.reason === 'domain'
    )!;
    expect(withHint.riskScore).toBeGreaterThan(noHint.riskScore);
  });

  it('clamps cluster risk score to <= 1.0', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item({
        thingId: `t3_${i}`,
        urls: ['https://x.com'],
        createdAt: '2026-01-01T00:00:00Z',
        riskHint: 1,
      })
    );
    const cluster = clusterItems(items, { minGroupSize: 3 }).find((c) => c.reason === 'domain')!;
    expect(cluster.riskScore).toBeLessThanOrEqual(1);
  });

  it('returns clusters sorted by riskScore descending', () => {
    const items = [
      item({ thingId: 't3_1', urls: ['https://a.com'] }),
      item({ thingId: 't3_2', urls: ['https://a.com'] }),
      item({ thingId: 't3_3', urls: ['https://a.com'], riskHint: 0.9 }),
      item({ thingId: 't3_4', urls: ['https://b.com'] }),
      item({ thingId: 't3_5', urls: ['https://b.com'] }),
      item({ thingId: 't3_6', urls: ['https://b.com'] }),
    ];
    const clusters = clusterItems(items, { minGroupSize: 3 });
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1]!.riskScore).toBeGreaterThanOrEqual(clusters[i]!.riskScore);
    }
  });
});
