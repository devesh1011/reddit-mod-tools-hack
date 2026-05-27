import { describe, expect, it } from 'vitest';
import {
  buildAdjudicateUserMessage,
  buildNarrateUserMessage,
} from '../src/core/agent-prompts';

describe('buildAdjudicateUserMessage', () => {
  it('wraps both bodies in delimiters', () => {
    const msg = buildAdjudicateUserMessage({
      bodyBefore: 'original text',
      bodyAfter: 'edited text with link',
      addedUrls: ['https://example.com'],
      authorAgeDays: 5,
      heuristicScore: 0.55,
      heuristicSignals: ['shortener', 'new-domain'],
    });
    expect(msg).toContain('<body_before>\noriginal text\n</body_before>');
    expect(msg).toContain('<body_after>\nedited text with link\n</body_after>');
    expect(msg).toContain('Heuristic score: 0.55');
    expect(msg).toContain('shortener, new-domain');
    expect(msg).toContain('Author account age (days): 5');
  });

  it('renders "unknown" for null author age', () => {
    const msg = buildAdjudicateUserMessage({
      bodyBefore: 'a',
      bodyAfter: 'b',
      addedUrls: [],
      authorAgeDays: null,
      heuristicScore: 0.4,
      heuristicSignals: [],
    });
    expect(msg).toContain('Author account age (days): unknown');
    expect(msg).toContain('Heuristic signals: none');
    expect(msg).toContain('Added URLs: none');
  });

  it('truncates bodies past the cap', () => {
    const longBody = 'x'.repeat(2000);
    const msg = buildAdjudicateUserMessage({
      bodyBefore: longBody,
      bodyAfter: longBody,
      addedUrls: [],
      authorAgeDays: null,
      heuristicScore: 0.5,
      heuristicSignals: [],
    });
    expect(msg).toContain('…');
    expect(msg.length).toBeLessThan(longBody.length * 2);
  });
});

describe('buildNarrateUserMessage', () => {
  it('renders cluster header + items block', () => {
    const msg = buildNarrateUserMessage({
      cluster: {
        id: 'c1',
        reason: 'domain',
        label: 'bad.example',
        summary: '3 items sharing bad.example',
        riskScore: 0.6,
        detectedAt: '2026-05-27T12:00:00Z',
        itemIds: ['t3_a', 't3_b', 't3_c'],
      },
      itemPreviews: [
        { thingId: 't3_a', bodyPreview: 'spam pitch', urls: ['https://bad.example/1'] },
        { thingId: 't3_b', bodyPreview: 'another pitch', urls: ['https://bad.example/2'] },
      ],
    });
    expect(msg).toContain('Clustering reason: domain');
    expect(msg).toContain('Cluster label: bad.example');
    expect(msg).toContain('Heuristic risk score: 0.60');
    expect(msg).toContain('Item count: 3');
    expect(msg).toContain('[item 1] t3_a');
    expect(msg).toContain('body: spam pitch');
    expect(msg).toContain('<items>');
  });

  it('shows placeholder when no previews', () => {
    const msg = buildNarrateUserMessage({
      cluster: {
        id: 'c1',
        reason: 'author',
        label: 'u/spammer',
        summary: '',
        riskScore: 0.5,
        detectedAt: '2026-05-27T12:00:00Z',
        itemIds: ['t3_a'],
      },
      itemPreviews: [],
    });
    expect(msg).toContain('(no item previews available)');
  });
});
