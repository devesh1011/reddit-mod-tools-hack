import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const adjudicateEditOutput = z.object({
  verdict: z.enum(['spam', 'legit', 'unclear']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(4),
  suggestedAction: z.enum(['remove', 'flag', 'ignore']),
});

const narrateClusterOutput = z.object({
  narrative: z.string().max(500),
  campaignType: z.enum([
    'affiliate_spam',
    'crypto_scam',
    'malware_link',
    'engagement_farming',
    'astroturfing',
    'unknown_coordinated',
    'likely_benign',
  ]),
  recommendedAction: z.enum(['remove_all', 'review_individually', 'dismiss']),
  riskAdjustment: z.number().min(-0.3).max(0.3),
});

describe('adjudicateEditOutput schema', () => {
  it('accepts a valid verdict', () => {
    const out = adjudicateEditOutput.parse({
      verdict: 'spam',
      confidence: 0.85,
      reasons: ['shortener present', 'new account'],
      suggestedAction: 'remove',
    });
    expect(out.verdict).toBe('spam');
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(() =>
      adjudicateEditOutput.parse({
        verdict: 'spam',
        confidence: 1.5,
        reasons: [],
        suggestedAction: 'flag',
      })
    ).toThrow();
  });

  it('rejects unknown verdict', () => {
    expect(() =>
      adjudicateEditOutput.parse({
        verdict: 'maybe',
        confidence: 0.5,
        reasons: [],
        suggestedAction: 'flag',
      })
    ).toThrow();
  });

  it('rejects more than 4 reasons', () => {
    expect(() =>
      adjudicateEditOutput.parse({
        verdict: 'unclear',
        confidence: 0.5,
        reasons: ['a', 'b', 'c', 'd', 'e'],
        suggestedAction: 'flag',
      })
    ).toThrow();
  });
});

describe('narrateClusterOutput schema', () => {
  it('rejects riskAdjustment above +0.3', () => {
    expect(() =>
      narrateClusterOutput.parse({
        narrative: 'looks bad',
        campaignType: 'affiliate_spam',
        recommendedAction: 'remove_all',
        riskAdjustment: 0.9,
      })
    ).toThrow();
  });

  it('rejects riskAdjustment below -0.3', () => {
    expect(() =>
      narrateClusterOutput.parse({
        narrative: 'looks fine',
        campaignType: 'likely_benign',
        recommendedAction: 'dismiss',
        riskAdjustment: -0.9,
      })
    ).toThrow();
  });

  it('rejects narrative over 500 chars', () => {
    expect(() =>
      narrateClusterOutput.parse({
        narrative: 'x'.repeat(501),
        campaignType: 'astroturfing',
        recommendedAction: 'review_individually',
        riskAdjustment: 0,
      })
    ).toThrow();
  });

  it('accepts valid narration', () => {
    const out = narrateClusterOutput.parse({
      narrative: 'three different authors posting the same shortened URL within 5 minutes',
      campaignType: 'unknown_coordinated',
      recommendedAction: 'remove_all',
      riskAdjustment: 0.2,
    });
    expect(out.recommendedAction).toBe('remove_all');
  });
});
