import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import {
  acquireReview,
  heartbeatReview,
  listActiveLocks,
  releaseReview,
  reviewingChannel,
} from '../core/collision-shield';
import { alertsChannel } from '../core/cluster-radar';
import { bulkAction, runClusterScan } from '../core/cluster-radar';
import {
  listClusterIds,
  readAlert,
  readCluster,
  readClusterNarration,
  readClusterState,
  readLatestEditLog,
  readSettings,
  recentAlertIds,
  removeCluster,
} from '../core/redis-schema';
import type { NarrateClusterOutput } from '../core/agent';

export const api = new Hono();

type ReviewRequest = { thingId?: string };

async function currentReviewer(): Promise<string | null> {
  const user = await reddit.getCurrentUser();
  return user?.username ?? null;
}

async function ensureCollisionShieldEnabled(): Promise<boolean> {
  const settings = await readSettings();
  return settings.collisionShieldEnabled;
}

async function ensureClusterRadarEnabled(): Promise<boolean> {
  const settings = await readSettings();
  return settings.clusterRadarEnabled;
}

api.post('/review-start', async (c) => {
  if (!(await ensureCollisionShieldEnabled())) {
    return c.json({ error: 'collision shield disabled' }, 403);
  }
  const body = await c.req.json<ReviewRequest>().catch(() => ({}) as ReviewRequest);
  if (!body.thingId) return c.json({ error: 'thingId required' }, 400);
  const reviewer = await currentReviewer();
  if (!reviewer) return c.json({ error: 'not signed in' }, 401);

  const result = await acquireReview(body.thingId, reviewer);
  if (result.kind === 'collision') {
    return c.json(
      {
        collision: true,
        reviewer: result.existing.reviewer,
        startedAt: result.existing.startedAt,
      },
      200
    );
  }
  return c.json(
    {
      collision: false,
      reviewer: result.lock.reviewer,
      startedAt: result.lock.startedAt,
      extended: result.kind === 'extended',
    },
    200
  );
});

api.post('/review-heartbeat', async (c) => {
  if (!(await ensureCollisionShieldEnabled())) {
    return c.json({ error: 'collision shield disabled' }, 403);
  }
  const body = await c.req.json<ReviewRequest>().catch(() => ({}) as ReviewRequest);
  if (!body.thingId) return c.json({ error: 'thingId required' }, 400);
  const reviewer = await currentReviewer();
  if (!reviewer) return c.json({ error: 'not signed in' }, 401);

  const result = await heartbeatReview(body.thingId, reviewer);
  if (result.kind === 'collision') {
    return c.json(
      {
        ok: false,
        collision: true,
        reviewer: result.existing.reviewer,
        startedAt: result.existing.startedAt,
      },
      200
    );
  }
  return c.json({ ok: true }, 200);
});

api.post('/review-release', async (c) => {
  const body = await c.req.json<ReviewRequest>().catch(() => ({}) as ReviewRequest);
  if (!body.thingId) return c.json({ error: 'thingId required' }, 400);
  const reviewer = await currentReviewer();
  if (!reviewer) return c.json({ error: 'not signed in' }, 401);

  const result = await releaseReview(body.thingId, reviewer);
  return c.json({ ok: true, kind: result.kind }, 200);
});

api.get('/review-active', async (c) => {
  const items = await listActiveLocks();
  return c.json({ items }, 200);
});

api.get('/dashboard-data', async (c) => {
  const subredditId = context.subredditId;
  const [state, clusterIds, alertIds, locks] = await Promise.all([
    readClusterState(),
    listClusterIds(25),
    recentAlertIds(15),
    listActiveLocks(),
  ]);
  const clusters = (
    await Promise.all(clusterIds.map((id) => readCluster(id)))
  ).filter((c): c is NonNullable<typeof c> => c !== null);
  const narrations = await Promise.all(
    clusters.map(async (cl) => {
      const n = await readClusterNarration<NarrateClusterOutput>(cl.id);
      return n ? { clusterId: cl.id, ...n } : null;
    })
  );
  const clusterNarrations = narrations.filter(
    (n): n is NonNullable<typeof n> => n !== null
  );
  const alerts = (
    await Promise.all(alertIds.map((id) => readAlert(id)))
  ).filter((a): a is NonNullable<typeof a> => a !== null);
  const channels = subredditId
    ? {
        reviewing: reviewingChannel(subredditId),
        alerts: alertsChannel(subredditId),
      }
    : null;
  return c.json({ state, clusters, clusterNarrations, alerts, locks, channels }, 200);
});

api.post('/cluster-scan-now', async (c) => {
  if (!(await ensureClusterRadarEnabled())) {
    return c.json({ error: 'cluster radar disabled' }, 403);
  }
  const result = await runClusterScan();
  return c.json(result, 200);
});

api.get('/settings', async (c) => {
  const settings = await readSettings();
  return c.json(settings, 200);
});

api.get('/edit-log', async (c) => {
  const thingId = c.req.query('thingId');
  if (!thingId) return c.json({ error: 'thingId required' }, 400);
  const event = await readLatestEditLog(thingId);
  if (!event) return c.json({ event: null }, 200);
  return c.json({ event }, 200);
});

api.get('/me', async (c) => {
  const user = await reddit.getCurrentUser();
  if (!user) return c.json({ username: null }, 200);
  return c.json({ username: user.username }, 200);
});

type BulkActionRequest = { clusterId?: string; action?: 'remove' | 'ignore' };

api.post('/bulk-action', async (c) => {
  const body = await c.req.json<BulkActionRequest>().catch(() => ({}) as BulkActionRequest);
  if (!body.clusterId || (body.action !== 'remove' && body.action !== 'ignore')) {
    return c.json({ error: 'clusterId and action ("remove"|"ignore") required' }, 400);
  }
  const cluster = await readCluster(body.clusterId);
  if (!cluster) {
    return c.json({ error: 'cluster not found' }, 404);
  }
  const result = await bulkAction(cluster, body.action);
  await removeCluster(cluster.id);
  return c.json(result, 200);
});
