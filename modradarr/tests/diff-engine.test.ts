import { describe, expect, it } from 'vitest';
import {
  diffPreview,
  diffUrls,
  extractDomain,
  extractUrls,
  hashBody,
  isWithinEditWindow,
} from '../src/core/diff-engine';

describe('hashBody', () => {
  it('is deterministic for identical input', () => {
    expect(hashBody('hello world')).toBe(hashBody('hello world'));
  });

  it('differs for whitespace-only edits', () => {
    expect(hashBody('hello world')).not.toBe(hashBody('hello  world'));
  });

  it('produces a 64-char hex digest', () => {
    const h = hashBody('any input');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractUrls', () => {
  it('returns empty list for empty body', () => {
    expect(extractUrls('')).toEqual([]);
  });

  it('finds http and https URLs', () => {
    const urls = extractUrls('check https://example.com and http://foo.bar/baz?x=1');
    expect(urls).toEqual(
      expect.arrayContaining(['https://example.com/', 'http://foo.bar/baz?x=1'])
    );
  });

  it('finds bare-host URLs by promoting to https', () => {
    const urls = extractUrls('visit bit.ly/abc123 today');
    expect(urls.some((u) => u.includes('bit.ly'))).toBe(true);
  });

  it('strips the URL hash fragment', () => {
    const urls = extractUrls('https://example.com/path#section');
    expect(urls).toContain('https://example.com/path');
  });

  it('dedupes repeated URLs', () => {
    const urls = extractUrls('https://example.com https://example.com');
    expect(urls.filter((u) => u.startsWith('https://example.com'))).toHaveLength(1);
  });

  it('skips bare words without a TLD', () => {
    expect(extractUrls('just some text without urls')).toEqual([]);
  });
});

describe('extractDomain', () => {
  it('strips www and lowercases', () => {
    expect(extractDomain('https://WWW.Example.com/path')).toBe('example.com');
  });

  it('returns null for non-URL input', () => {
    expect(extractDomain('not a url')).toBeNull();
  });
});

describe('diffUrls', () => {
  it('finds added and removed sets', () => {
    const result = diffUrls(['a', 'b'], ['b', 'c']);
    expect(result.added).toEqual(['c']);
    expect(result.removed).toEqual(['a']);
  });

  it('empty result when sets are identical', () => {
    expect(diffUrls(['a', 'b'], ['a', 'b'])).toEqual({ added: [], removed: [] });
  });

  it('preserves input order in added array', () => {
    const result = diffUrls([], ['third', 'first', 'second']);
    expect(result.added).toEqual(['third', 'first', 'second']);
  });
});

describe('diffPreview', () => {
  it('truncates inputs at the cap with an ellipsis', () => {
    const old = 'a'.repeat(400);
    const next = 'b'.repeat(400);
    const preview = diffPreview(old, next, 50);
    expect(preview).toContain('…');
    expect(preview).toContain('BEFORE:');
    expect(preview).toContain('AFTER:');
  });

  it('returns full text under the cap', () => {
    const preview = diffPreview('short before', 'short after', 100);
    expect(preview).toBe('BEFORE: short before\n\nAFTER: short after');
  });
});

describe('isWithinEditWindow', () => {
  it('returns true within the window', () => {
    const created = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(isWithinEditWindow(created, 24)).toBe(true);
  });

  it('returns false past the window', () => {
    const created = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    expect(isWithinEditWindow(created, 24)).toBe(false);
  });

  it('returns false for unparseable timestamp', () => {
    expect(isWithinEditWindow('not-a-date', 24)).toBe(false);
  });
});
