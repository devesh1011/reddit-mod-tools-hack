import { reddit } from '@devvit/web/server';
import {
  appendEditLog,
  deleteSnapshot,
  markIdempotent,
  readSettings,
  readSnapshot,
  recordRecent,
  storeAlert,
  writeSnapshot,
  type Alert,
  type Snapshot,
} from './redis-schema';
import {
  diffPreview,
  diffUrls,
  extractUrls,
  hashBody,
  isWithinEditWindow,
} from './diff-engine';
import { maxScore, recordReportedDomains, scoreUrls, type UrlScore } from './url-scorer';

type ThingType = 'post' | 'comment';

type TriggerPayload = {
  type: ThingType;
  thingId: string;
  body: string;
  authorId: string | undefined;
  authorName: string | undefined;
  permalink: string | undefined;
  createdAt: string | undefined;
};

export async function handleSubmit(payload: TriggerPayload): Promise<void> {
  if (!payload.thingId || !payload.body || !payload.authorId) return;

  const createdAt = payload.createdAt ?? new Date().toISOString();
  const bodyHash = hashBody(payload.body);
  const urls = extractUrls(payload.body);

  const snapshot: Snapshot = {
    body: payload.body,
    bodyHash,
    urls,
    createdAt,
    authorId: payload.authorId,
  };

  await writeSnapshot(payload.thingId, snapshot);
  await recordRecent(payload.thingId, createdAt);
}

export async function handleUpdate(payload: TriggerPayload): Promise<void> {
  if (!payload.thingId) return;

  const settings = await readSettings();
  if (!settings.editRadarEnabled) return;

  const fresh = await fetchBody(payload.type, payload.thingId);
  const body = fresh?.body ?? payload.body;
  if (!body) return;
  const authorName = fresh?.authorName ?? payload.authorName ?? '[deleted]';
  // '[deleted]' is Reddit's convention when the author account is removed; not a placeholder.
  const permalink = fresh?.permalink ?? payload.permalink ?? '';

  const newHash = hashBody(body);
  const prior = await readSnapshot(payload.thingId);

  if (!prior) {
    if (!payload.authorId) return;
    const createdAt = payload.createdAt ?? new Date().toISOString();
    await writeSnapshot(payload.thingId, {
      body,
      bodyHash: newHash,
      urls: extractUrls(body),
      createdAt,
      authorId: payload.authorId,
    });
    return;
  }

  if (prior.bodyHash === newHash) return;

  if (!isWithinEditWindow(prior.createdAt, settings.editWindowHours)) {
    await writeSnapshot(payload.thingId, {
      body,
      bodyHash: newHash,
      urls: extractUrls(body),
      createdAt: prior.createdAt,
      authorId: prior.authorId,
    });
    return;
  }

  const proceed = await markIdempotent(`edit:${payload.thingId}:${newHash}`);
  if (!proceed) return;

  const newUrls = extractUrls(body);
  const urlDiff = diffUrls(prior.urls, newUrls);

  await appendEditLog(payload.thingId, {
    timestamp: new Date().toISOString(),
    addedUrls: urlDiff.added,
    removedUrls: urlDiff.removed,
    diffPreview: diffPreview(prior.body, body),
  });

  await writeSnapshot(payload.thingId, {
    body,
    bodyHash: newHash,
    urls: newUrls,
    createdAt: prior.createdAt,
    authorId: prior.authorId,
  });

  if (urlDiff.added.length === 0) return;

  const scores = await scoreUrls(urlDiff.added);
  const top = maxScore(scores);
  if (top < settings.minDomainRiskScore) {
    return;
  }

  await recordReportedDomains(scores.map((s) => s.domain));

  const shouldRemove =
    settings.autoRemoveThreshold > 0 && top >= settings.autoRemoveThreshold;

  let removed = false;
  if (shouldRemove) {
    try {
      const id =
        payload.type === 'post'
          ? (payload.thingId as `t3_${string}`)
          : (payload.thingId as `t1_${string}`);
      await reddit.remove(id, true);
      removed = true;
    } catch (err) {
      console.error('[modradar] auto-remove failed', err);
    }
  }

  const alert: Alert = {
    thingId: payload.thingId,
    type: payload.type,
    authorId: prior.authorId,
    authorName,
    permalink,
    addedUrls: urlDiff.added,
    riskScore: top,
    detectedAt: new Date().toISOString(),
    removed,
  };
  await storeAlert(alert);

  console.log(
    `[modradar] edit alert ${payload.type} ${payload.thingId} score=${top.toFixed(2)} added=${urlDiff.added.length} removed=${removed} signals=${signalSummary(scores)}`
  );
}

export async function handleDelete(thingId: string): Promise<void> {
  if (!thingId) return;
  await deleteSnapshot(thingId);
}

type FetchedBody = {
  body: string;
  authorName: string;
  permalink: string;
};

async function fetchBody(type: ThingType, thingId: string): Promise<FetchedBody | null> {
  try {
    if (type === 'post') {
      const post = await reddit.getPostById(thingId as `t3_${string}`);
      const body = postBody(post);
      return {
        body,
        authorName: post.authorName ?? '[deleted]',
        permalink: post.permalink ?? '',
      };
    }
    const comment = await reddit.getCommentById(thingId as `t1_${string}`);
    return {
      body: comment.body ?? '',
      authorName: comment.authorName ?? '[deleted]',
      permalink: comment.permalink ?? '',
    };
  } catch (err) {
    console.error(`[modradar] fetchBody failed ${type} ${thingId}`, err);
    return null;
  }
}

function postBody(post: { body?: string | undefined; url?: string | undefined; title?: string | undefined }): string {
  const parts: string[] = [];
  if (post.title) parts.push(post.title);
  if (post.body) parts.push(post.body);
  if (post.url) parts.push(post.url);
  return parts.join('\n');
}

function signalSummary(scores: UrlScore[]): string {
  if (scores.length === 0) return 'none';
  return scores
    .map((s) => `${s.domain}(${s.score.toFixed(2)}|${s.signals.join(',')})`)
    .join(';');
}
