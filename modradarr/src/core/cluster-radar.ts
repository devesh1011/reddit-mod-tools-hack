import { context, realtime, reddit } from '@devvit/web/server';
import {
  readAlert,
  readReportSignal,
  readSnapshot,
  recentAlertIds,
  recentThingIds,
  writeClusterNarration,
  writeClusters,
  type StoredCluster,
} from './redis-schema';
import { clusterItems, type Cluster, type ModqueueItem } from './clustering';
import { narrateCluster, type NarrateClusterOutput } from './agent';

const SCAN_WINDOW_HOURS = 24;
const ITEM_LIMIT = 500;

export function alertsChannel(subredditId: string): string {
  return `modradar-${subredditId}-alerts`;
}

type AlertEvent =
  | { type: 'cluster-scan'; clusters: number; scanned: number; at: string }
  | { type: 'bulk-action-complete'; clusterId: string; action: string; affected: number };

async function broadcastAlert(event: AlertEvent): Promise<void> {
  const subredditId = context.subredditId;
  if (!subredditId) return;
  try {
    await realtime.send(alertsChannel(subredditId), event);
  } catch (err) {
    console.error('[modradar] realtime alert broadcast failed', err);
  }
}

export async function runClusterScan(): Promise<{
  scanned: number;
  clusters: number;
}> {
  const since = Date.now() - SCAN_WINDOW_HOURS * 60 * 60 * 1000;
  const ids = await recentThingIds(since);
  const trimmed = ids.slice(-ITEM_LIMIT);

  const alertIds = new Set(await recentAlertIds(100));
  const alertScores = new Map<string, number>();
  for (const id of alertIds) {
    const alert = await readAlert(id);
    if (alert) alertScores.set(id, alert.riskScore);
  }

  const items: ModqueueItem[] = [];
  for (const thingId of trimmed) {
    const snapshot = await readSnapshot(thingId);
    if (!snapshot) continue;
    const type: ModqueueItem['type'] = thingId.startsWith('t3_') ? 'post' : 'comment';
    const reportCount = await readReportSignal(thingId);
    const reportHint = reportCount > 0 ? Math.min(1, 0.3 + 0.15 * reportCount) : 0;
    const alertHint = alertScores.get(thingId) ?? 0;
    const hint = Math.max(reportHint, alertHint);
    items.push({
      thingId,
      type,
      authorId: snapshot.authorId,
      authorName: snapshot.authorId,
      permalink: '',
      urls: snapshot.urls,
      createdAt: snapshot.createdAt,
      bodyPreview: snapshot.body.slice(0, 200),
      ...(hint > 0 ? { riskHint: hint } : {}),
    });
  }

  const clusters = clusterItems(items, { minGroupSize: 3, timeWindowMinutes: 10 });
  await enrichClusterItems(clusters);
  const stored = clusters.map(toStored);
  await writeClusters(stored);
  await narrateHighRiskClusters(clusters, stored);
  await broadcastAlert({
    type: 'cluster-scan',
    clusters: clusters.length,
    scanned: items.length,
    at: new Date().toISOString(),
  });
  return { scanned: items.length, clusters: clusters.length };
}

const NARRATION_RISK_THRESHOLD = 0.4;
const MAX_NARRATIONS_PER_SCAN = 4;

async function narrateHighRiskClusters(
  clusters: Cluster[],
  stored: StoredCluster[]
): Promise<void> {
  let calls = 0;
  for (let i = 0; i < stored.length && calls < MAX_NARRATIONS_PER_SCAN; i++) {
    const s = stored[i];
    const c = clusters[i];
    if (!s || !c || s.riskScore < NARRATION_RISK_THRESHOLD) continue;
    const previews = c.items.slice(0, 10).map((item) => ({
      thingId: item.thingId,
      bodyPreview: item.bodyPreview,
      urls: item.urls,
    }));
    let result: NarrateClusterOutput | null = null;
    try {
      result = await narrateCluster(s, previews);
    } catch (err) {
      console.error('[modradar] narrateCluster threw unexpectedly', err);
    }
    if (result) {
      await writeClusterNarration(s.id, result);
      calls++;
    }
  }
}

async function enrichClusterItems(clusters: Cluster[]): Promise<void> {
  const unique = new Map<string, ModqueueItem[]>();
  for (const c of clusters) {
    for (const item of c.items) {
      const list = unique.get(item.thingId) ?? [];
      list.push(item);
      unique.set(item.thingId, list);
    }
  }
  for (const [thingId, refs] of unique) {
    try {
      const type: ModqueueItem['type'] = thingId.startsWith('t3_') ? 'post' : 'comment';
      if (type === 'post') {
        const p = await reddit.getPostById(thingId as `t3_${string}`);
        const name = p.authorName ?? refs[0]?.authorName ?? '';
        const link = p.permalink ?? '';
        for (const ref of refs) {
          ref.authorName = name;
          ref.permalink = link;
        }
      } else {
        const cmt = await reddit.getCommentById(thingId as `t1_${string}`);
        const name = cmt.authorName ?? refs[0]?.authorName ?? '';
        const link = cmt.permalink ?? '';
        for (const ref of refs) {
          ref.authorName = name;
          ref.permalink = link;
        }
      }
    } catch (err) {
      console.warn(`[modradar] enrichClusterItems failed for ${thingId}`, err);
    }
  }
}

function toStored(c: Cluster): StoredCluster {
  return {
    id: c.id,
    reason: c.reason,
    label: c.label,
    summary: c.summary,
    riskScore: c.riskScore,
    detectedAt: c.detectedAt,
    itemIds: c.items.map((i) => i.thingId),
  };
}

export type BulkActionResult = {
  clusterId: string;
  action: 'remove' | 'ignore';
  affected: number;
  failures: number;
};

export async function bulkAction(
  cluster: StoredCluster,
  action: 'remove' | 'ignore'
): Promise<BulkActionResult> {
  if (action === 'ignore') {
    await broadcastAlert({
      type: 'bulk-action-complete',
      clusterId: cluster.id,
      action,
      affected: cluster.itemIds.length,
    });
    return { clusterId: cluster.id, action, affected: cluster.itemIds.length, failures: 0 };
  }

  let affected = 0;
  let failures = 0;
  for (const thingId of cluster.itemIds) {
    try {
      const typed =
        thingId.startsWith('t3_')
          ? (thingId as `t3_${string}`)
          : (thingId as `t1_${string}`);
      await reddit.remove(typed, true);
      affected++;
    } catch (err) {
      failures++;
      console.error(`[modradar] bulkAction remove failed for ${thingId}`, err);
    }
  }
  await broadcastAlert({
    type: 'bulk-action-complete',
    clusterId: cluster.id,
    action,
    affected,
  });
  return { clusterId: cluster.id, action, affected, failures };
}
