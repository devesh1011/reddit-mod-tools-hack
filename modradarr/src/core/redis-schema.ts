import { redis, context } from '@devvit/web/server';

const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;
const EDITLOG_TTL_SECONDS = 30 * 24 * 60 * 60;
const ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;
const RECENT_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_TTL_SECONDS = 60;

const ns = (subredditId: string) => `mr:${subredditId}`;

export type Snapshot = {
  body: string;
  bodyHash: string;
  urls: string[];
  createdAt: string;
  authorId: string;
};

export type EditEvent = {
  timestamp: string;
  addedUrls: string[];
  removedUrls: string[];
  diffPreview: string;
};

export type Alert = {
  thingId: string;
  type: 'post' | 'comment';
  authorId: string;
  authorName: string;
  permalink: string;
  addedUrls: string[];
  riskScore: number;
  detectedAt: string;
  removed: boolean;
};

export type Settings = {
  editWindowHours: number;
  minDomainRiskScore: number;
  autoRemoveThreshold: number;
  clusterMinGroupSize: number;
  editRadarEnabled: boolean;
  collisionShieldEnabled: boolean;
  clusterRadarEnabled: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  editWindowHours: 24,
  minDomainRiskScore: 0.5,
  autoRemoveThreshold: 0,
  clusterMinGroupSize: 3,
  editRadarEnabled: true,
  collisionShieldEnabled: true,
  clusterRadarEnabled: true,
};

const requireSubredditId = (): string => {
  const id = context.subredditId;
  if (!id) throw new Error('subredditId missing from context');
  return id;
};

export async function writeSnapshot(thingId: string, snapshot: Snapshot): Promise<void> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:snapshot:${thingId}`;
  await redis.hSet(key, {
    body: snapshot.body,
    bodyHash: snapshot.bodyHash,
    urls: JSON.stringify(snapshot.urls),
    createdAt: snapshot.createdAt,
    authorId: snapshot.authorId,
  });
  await redis.expire(key, SNAPSHOT_TTL_SECONDS);
}

export async function readSnapshot(thingId: string): Promise<Snapshot | null> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:snapshot:${thingId}`;
  const raw = await redis.hGetAll(key);
  if (!raw || !raw.body || !raw.bodyHash || !raw.createdAt || !raw.authorId) {
    return null;
  }
  let urls: string[];
  try {
    urls = raw.urls ? (JSON.parse(raw.urls) as string[]) : [];
  } catch {
    urls = [];
  }
  return {
    body: raw.body,
    bodyHash: raw.bodyHash,
    urls,
    createdAt: raw.createdAt,
    authorId: raw.authorId,
  };
}

export async function deleteSnapshot(thingId: string): Promise<void> {
  const subredditId = requireSubredditId();
  await redis.del(`${ns(subredditId)}:snapshot:${thingId}`);
  await redis.del(`${ns(subredditId)}:editlog:${thingId}`);
}

export async function appendEditLog(thingId: string, event: EditEvent): Promise<void> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:editlog:${thingId}`;
  await redis.zAdd(key, { score: Date.parse(event.timestamp), member: JSON.stringify(event) });
  await redis.expire(key, EDITLOG_TTL_SECONDS);
}

export async function storeAlert(alert: Alert): Promise<void> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:alert:${alert.thingId}`;
  await redis.hSet(key, {
    payload: JSON.stringify(alert),
    detectedAt: alert.detectedAt,
    riskScore: String(alert.riskScore),
  });
  await redis.expire(key, ALERT_TTL_SECONDS);

  const indexKey = `${ns(subredditId)}:alerts:active`;
  await redis.zAdd(indexKey, { score: Date.parse(alert.detectedAt), member: alert.thingId });
  await redis.expire(indexKey, ALERT_TTL_SECONDS);
}

export async function recordRecent(thingId: string, createdAt: string): Promise<void> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:recent`;
  await redis.zAdd(key, { score: Date.parse(createdAt), member: thingId });
  await redis.expire(key, RECENT_TTL_SECONDS);
}

export async function markIdempotent(eventKey: string): Promise<boolean> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:idem:${eventKey}`;
  const existing = await redis.get(key);
  if (existing) return false;
  await redis.set(key, '1');
  await redis.expire(key, IDEMPOTENCY_TTL_SECONDS);
  return true;
}

export async function bumpDomainReport(domain: string): Promise<number> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:urldomain:${domain}`;
  const count = await redis.hIncrBy(key, 'reportCount', 1);
  await redis.hSet(key, { lastSeen: new Date().toISOString() });
  return count;
}

export async function getDomainReportCount(domain: string): Promise<number> {
  const subredditId = requireSubredditId();
  const raw = await redis.hGet(`${ns(subredditId)}:urldomain:${domain}`, 'reportCount');
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export async function readSettings(): Promise<Settings> {
  const subredditId = requireSubredditId();
  const raw = await redis.hGetAll(`${ns(subredditId)}:settings`);
  if (!raw || Object.keys(raw).length === 0) return DEFAULT_SETTINGS;
  return {
    editWindowHours: numOr(raw.editWindowHours, DEFAULT_SETTINGS.editWindowHours),
    minDomainRiskScore: numOr(raw.minDomainRiskScore, DEFAULT_SETTINGS.minDomainRiskScore),
    autoRemoveThreshold: numOr(raw.autoRemoveThreshold, DEFAULT_SETTINGS.autoRemoveThreshold),
    clusterMinGroupSize: numOr(raw.clusterMinGroupSize, DEFAULT_SETTINGS.clusterMinGroupSize),
    editRadarEnabled: raw.editRadarEnabled !== 'false',
    collisionShieldEnabled: raw.collisionShieldEnabled !== 'false',
    clusterRadarEnabled: raw.clusterRadarEnabled !== 'false',
  };
}

export async function writeDefaultSettings(): Promise<void> {
  await writeSettings(DEFAULT_SETTINGS);
}

export async function writeSettings(settings: Settings): Promise<void> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:settings`;
  await redis.hSet(key, {
    editWindowHours: String(settings.editWindowHours),
    minDomainRiskScore: String(settings.minDomainRiskScore),
    autoRemoveThreshold: String(settings.autoRemoveThreshold),
    clusterMinGroupSize: String(settings.clusterMinGroupSize),
    editRadarEnabled: String(settings.editRadarEnabled),
    collisionShieldEnabled: String(settings.collisionShieldEnabled),
    clusterRadarEnabled: String(settings.clusterRadarEnabled),
  });
}

export async function recentAlertIds(limit = 25): Promise<string[]> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:alerts:active`;
  const members = await redis.zRange(key, 0, limit - 1, { reverse: true, by: 'rank' });
  return members.map((m) => m.member);
}

export async function recentThingIds(sinceMs: number): Promise<string[]> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:recent`;
  const members = await redis.zRange(key, sinceMs, Date.now(), {
    by: 'score',
  });
  return members.map((m) => m.member);
}

const CLUSTER_TTL_SECONDS = 60 * 60;

export type StoredCluster = {
  id: string;
  reason: string;
  label: string;
  summary: string;
  riskScore: number;
  detectedAt: string;
  itemIds: string[];
};

export async function writeClusters(clusters: StoredCluster[]): Promise<void> {
  const subredditId = requireSubredditId();
  const indexKey = `${ns(subredditId)}:clusters:active`;
  await redis.del(indexKey);
  const stateKey = `${ns(subredditId)}:clusters:state`;
  await redis.hSet(stateKey, {
    lastScanAt: new Date().toISOString(),
    count: String(clusters.length),
  });
  await redis.expire(stateKey, CLUSTER_TTL_SECONDS);

  for (const c of clusters) {
    const dataKey = `${ns(subredditId)}:cluster:${c.id}`;
    await redis.hSet(dataKey, {
      payload: JSON.stringify(c),
    });
    await redis.expire(dataKey, CLUSTER_TTL_SECONDS);
    await redis.zAdd(indexKey, { score: c.riskScore, member: c.id });
  }
  if (clusters.length > 0) {
    await redis.expire(indexKey, CLUSTER_TTL_SECONDS);
  }
}

export async function listClusterIds(limit = 25): Promise<string[]> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:clusters:active`;
  const members = await redis.zRange(key, 0, limit - 1, { reverse: true, by: 'rank' });
  return members.map((m) => m.member);
}

export async function readCluster(clusterId: string): Promise<StoredCluster | null> {
  const subredditId = requireSubredditId();
  const raw = await redis.hGet(`${ns(subredditId)}:cluster:${clusterId}`, 'payload');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCluster;
  } catch {
    return null;
  }
}

export async function readClusterState(): Promise<{
  lastScanAt: string | null;
  count: number;
}> {
  const subredditId = requireSubredditId();
  const raw = await redis.hGetAll(`${ns(subredditId)}:clusters:state`);
  if (!raw) return { lastScanAt: null, count: 0 };
  const count = numOr(raw.count, 0);
  return { lastScanAt: raw.lastScanAt ?? null, count };
}

export async function removeCluster(clusterId: string): Promise<void> {
  const subredditId = requireSubredditId();
  await redis.del(`${ns(subredditId)}:cluster:${clusterId}`);
  await redis.zRem(`${ns(subredditId)}:clusters:active`, [clusterId]);
}

const DASHBOARD_POST_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function getDashboardPostId(): Promise<string | null> {
  const subredditId = requireSubredditId();
  const raw = await redis.get(`${ns(subredditId)}:dashboard:postId`);
  return raw ?? null;
}

export async function setDashboardPostId(postId: string): Promise<void> {
  const subredditId = requireSubredditId();
  const key = `${ns(subredditId)}:dashboard:postId`;
  await redis.set(key, postId);
  await redis.expire(key, DASHBOARD_POST_TTL_SECONDS);
}

export async function clearDashboardPostId(): Promise<void> {
  const subredditId = requireSubredditId();
  await redis.del(`${ns(subredditId)}:dashboard:postId`);
}

export async function readAlert(thingId: string): Promise<Alert | null> {
  const subredditId = requireSubredditId();
  const raw = await redis.hGet(`${ns(subredditId)}:alert:${thingId}`, 'payload');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Alert;
  } catch {
    return null;
  }
}

function numOr(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const n = Number.parseFloat(input);
  return Number.isFinite(n) ? n : fallback;
}
