import { redis, context, realtime } from '@devvit/web/server';

const LOCK_TTL_SECONDS = 5 * 60;
const SET_TTL_SECONDS = 24 * 60 * 60;

const ns = (subredditId: string) => `mr:${subredditId}`;

const requireSubredditId = (): string => {
  const id = context.subredditId;
  if (!id) throw new Error('subredditId missing from context');
  return id;
};

export function reviewingChannel(subredditId: string): string {
  return `modradar-${subredditId}-reviewing`;
}

type ReviewingEvent =
  | { type: 'review-started'; thingId: string; reviewer: string; startedAt: string }
  | { type: 'review-extended'; thingId: string; reviewer: string; startedAt: string }
  | { type: 'review-ended'; thingId: string; reviewer: string };

async function broadcast(subredditId: string, event: ReviewingEvent): Promise<void> {
  try {
    await realtime.send(reviewingChannel(subredditId), event);
  } catch (err) {
    console.error('[modradar] realtime broadcast failed', err);
  }
}

export type ReviewLock = {
  thingId: string;
  reviewer: string;
  startedAt: string;
};

type StoredLock = { reviewer: string; startedAt: string };

const LOCK_SEPARATOR = '|';

function encode(lock: StoredLock): string {
  return `${lock.reviewer}${LOCK_SEPARATOR}${lock.startedAt}`;
}

function decode(raw: string): StoredLock | null {
  const idx = raw.indexOf(LOCK_SEPARATOR);
  if (idx <= 0) return null;
  const reviewer = raw.slice(0, idx);
  const startedAt = raw.slice(idx + 1);
  if (!reviewer || !startedAt) return null;
  return { reviewer, startedAt };
}

function lockKey(subredditId: string, thingId: string): string {
  return `${ns(subredditId)}:reviewing:${thingId}`;
}

function indexKey(subredditId: string): string {
  return `${ns(subredditId)}:reviewing:set`;
}

export type AcquireResult =
  | { kind: 'acquired'; lock: ReviewLock }
  | { kind: 'extended'; lock: ReviewLock }
  | { kind: 'collision'; existing: ReviewLock };

export async function acquireReview(
  thingId: string,
  reviewer: string
): Promise<AcquireResult> {
  const subredditId = requireSubredditId();
  const key = lockKey(subredditId, thingId);
  const existingRaw = await redis.get(key);

  if (existingRaw) {
    const existing = decode(existingRaw);
    if (existing && existing.reviewer === reviewer) {
      const lock: ReviewLock = {
        thingId,
        reviewer,
        startedAt: existing.startedAt,
      };
      await redis.expire(key, LOCK_TTL_SECONDS);
      await broadcast(subredditId, {
        type: 'review-extended',
        thingId,
        reviewer,
        startedAt: existing.startedAt,
      });
      return { kind: 'extended', lock };
    }
    if (existing) {
      return {
        kind: 'collision',
        existing: { thingId, reviewer: existing.reviewer, startedAt: existing.startedAt },
      };
    }
  }

  const startedAt = new Date().toISOString();
  await redis.set(key, encode({ reviewer, startedAt }));
  await redis.expire(key, LOCK_TTL_SECONDS);

  const setKey = indexKey(subredditId);
  await redis.zAdd(setKey, { score: Date.now(), member: thingId });
  await redis.expire(setKey, SET_TTL_SECONDS);

  await broadcast(subredditId, {
    type: 'review-started',
    thingId,
    reviewer,
    startedAt,
  });

  return { kind: 'acquired', lock: { thingId, reviewer, startedAt } };
}

export type ReleaseResult =
  | { kind: 'released'; lock: ReviewLock }
  | { kind: 'not-owner'; existing: ReviewLock }
  | { kind: 'no-lock' };

export async function releaseReview(
  thingId: string,
  reviewer: string
): Promise<ReleaseResult> {
  const subredditId = requireSubredditId();
  const key = lockKey(subredditId, thingId);
  const raw = await redis.get(key);
  if (!raw) return { kind: 'no-lock' };
  const existing = decode(raw);
  if (!existing) {
    await redis.del(key);
    return { kind: 'no-lock' };
  }
  if (existing.reviewer !== reviewer) {
    return {
      kind: 'not-owner',
      existing: { thingId, reviewer: existing.reviewer, startedAt: existing.startedAt },
    };
  }
  await redis.del(key);
  await redis.zRem(indexKey(subredditId), [thingId]);
  await broadcast(subredditId, {
    type: 'review-ended',
    thingId,
    reviewer: existing.reviewer,
  });
  return {
    kind: 'released',
    lock: { thingId, reviewer: existing.reviewer, startedAt: existing.startedAt },
  };
}

export async function peekReview(thingId: string): Promise<ReviewLock | null> {
  const subredditId = requireSubredditId();
  const raw = await redis.get(lockKey(subredditId, thingId));
  if (!raw) return null;
  const decoded = decode(raw);
  if (!decoded) return null;
  return { thingId, reviewer: decoded.reviewer, startedAt: decoded.startedAt };
}

export async function heartbeatReview(
  thingId: string,
  reviewer: string
): Promise<AcquireResult> {
  return acquireReview(thingId, reviewer);
}

export async function listActiveLocks(): Promise<ReviewLock[]> {
  const subredditId = requireSubredditId();
  const members = await redis.zRange(indexKey(subredditId), 0, -1, {
    reverse: true,
    by: 'rank',
  });

  const locks: ReviewLock[] = [];
  const stale: string[] = [];

  for (const m of members) {
    const thingId = m.member;
    const lock = await peekReview(thingId);
    if (lock) {
      locks.push(lock);
    } else {
      stale.push(thingId);
    }
  }

  if (stale.length > 0) {
    await redis.zRem(indexKey(subredditId), stale);
  }

  return locks;
}

export async function cleanupStaleLocks(): Promise<number> {
  const subredditId = requireSubredditId();
  const members = await redis.zRange(indexKey(subredditId), 0, -1, { by: 'rank' });
  const stale: string[] = [];
  for (const m of members) {
    const exists = await redis.exists(lockKey(subredditId, m.member));
    if (!exists) stale.push(m.member);
  }
  if (stale.length > 0) {
    await redis.zRem(indexKey(subredditId), stale);
    for (const thingId of stale) {
      await broadcast(subredditId, { type: 'review-ended', thingId, reviewer: '' });
    }
  }
  return stale.length;
}

export function formatElapsed(startedAt: string): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 'unknown';
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
