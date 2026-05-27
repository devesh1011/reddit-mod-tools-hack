import { context, realtime, reddit } from '@devvit/web/server';
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
import { alertsChannel } from './cluster-radar';
import {
  diffPreview,
  diffUrls,
  extractUrls,
  hashBody,
  isWithinEditWindow,
} from './diff-engine';
import { maxScore, recordReportedDomains, scoreUrls, type UrlScore } from './url-scorer';
import { adjudicateEdit } from './agent';

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

export async function handleUpdate(payload: TriggerPayload): Promise<void> {  if (!payload.thingId) {return; }

  const settings = await readSettings();
  if (!settings.editRadarEnabled) {return; }

  const fresh = await fetchBody(payload.type, payload.thingId);
  const body = fresh?.body ?? payload.body;
  const authorName = fresh?.authorName ?? payload.authorName ?? '[deleted]';
  // '[deleted]' is Reddit's convention when the author account is removed; not a placeholder.
  const permalink = fresh?.permalink ?? payload.permalink ?? '';

  const newHash = hashBody(body);
  const prior = await readSnapshot(payload.thingId);

  if (!prior) {if (!payload.authorId) return;
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

  if (prior.bodyHash === newHash) {return; }

  if (!isWithinEditWindow(prior.createdAt, settings.editWindowHours)) {await writeSnapshot(payload.thingId, {
      body,
      bodyHash: newHash,
      urls: extractUrls(body),
      createdAt: prior.createdAt,
      authorId: prior.authorId,
    });
    return;
  }

  const proceed = await markIdempotent(`edit:${payload.thingId}:${newHash}`);
  if (!proceed) {return; }

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

  const nonRedditAdded = urlDiff.added.filter((u) => {
    try { return !new URL(u).hostname.endsWith('.reddit.com') && new URL(u).hostname !== 'reddit.com'; } catch { return true; }
  });

  if (nonRedditAdded.length === 0) {return; }

  const scores = await scoreUrls(nonRedditAdded);
  const heuristicTop = maxScore(scores);
  if (heuristicTop < settings.minDomainRiskScore) {return;
  }

  await recordReportedDomains(scores.map((s) => s.domain));

  let effectiveScore = heuristicTop;
  let agentVerdict: Awaited<ReturnType<typeof adjudicateEdit>> = null;
  try {
    agentVerdict = await adjudicateEdit({
      bodyBefore: prior.body,
      bodyAfter: body,
      addedUrls: urlDiff.added,
      authorAgeDays: null,
      heuristicScore: heuristicTop,
      heuristicSignals: collectSignalTags(scores),
    });
  } catch (err) {
    console.error('[modradar] adjudicateEdit threw unexpectedly', err);
  }
  if (agentVerdict) {
    if (agentVerdict.verdict === 'legit' && agentVerdict.confidence >= 0.7) {
      effectiveScore = Math.min(effectiveScore, 0.29);
    } else if (agentVerdict.verdict === 'spam' && agentVerdict.confidence >= 0.7) {
      effectiveScore = Math.max(effectiveScore, 0.7);
    }
  }

  if (effectiveScore < settings.minDomainRiskScore) {
    console.log(
      `[modradar] edit alert suppressed by agent (legit) ${payload.type} ${payload.thingId} heuristic=${heuristicTop.toFixed(2)}`
    );
    return;
  }

  const top = effectiveScore;
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

  if (settings.notificationLevel === 'off') {
    console.log(
      `[modradar] edit signal suppressed (notificationLevel=off) ${payload.type} ${payload.thingId} score=${top.toFixed(2)}`
    );
    return;
  }

  const alert: Alert = {
    thingId: payload.thingId,
    type: payload.type,
    authorId: prior.authorId,
    authorName,
    permalink,
    addedUrls: nonRedditAdded,
    riskScore: top,
    detectedAt: new Date().toISOString(),
    removed,
    heuristicScore: heuristicTop,
    ...(agentVerdict ? { agentVerdict } : {}),
  };
  await storeAlert(alert);

  if (settings.notificationLevel === 'realtime') {
    const subredditId = context.subredditId;
    if (subredditId) {
      try {
        await realtime.send(alertsChannel(subredditId), {
          type: 'edit-alert',
          thingId: alert.thingId,
          riskScore: alert.riskScore,
          detectedAt: alert.detectedAt,
        });
      } catch (err) {
        console.error('[modradar] edit alert broadcast failed', err);
      }
    }
  }

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

function collectSignalTags(scores: UrlScore[]): string[] {
  const tags = new Set<string>();
  for (const s of scores) {
    for (const sig of s.signals) tags.add(sig);
  }
  return Array.from(tags).slice(0, 12);
}
