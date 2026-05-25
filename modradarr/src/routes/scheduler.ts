import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { cleanupStaleLocks } from '../core/collision-shield';
import { runClusterScan } from '../core/cluster-radar';
import { readClusterState, readSettings } from '../core/redis-schema';

export const scheduler = new Hono();

scheduler.post('/collision-cleanup', async (c) => {
  await c.req.json<TaskRequest>().catch(() => ({}) as TaskRequest);
  const settings = await readSettings();
  if (!settings.collisionShieldEnabled) {
    return c.json<TaskResponse>({ status: 'success' }, 200);
  }
  const removed = await cleanupStaleLocks();
  if (removed > 0) {
    console.log(`[modradar] collision-cleanup removed ${removed} stale lock entries`);
  }
  return c.json<TaskResponse>({ status: 'success' }, 200);
});

scheduler.post('/cluster-scan', async (c) => {
  await c.req.json<TaskRequest>().catch(() => ({}) as TaskRequest);
  const settings = await readSettings();
  if (!settings.clusterRadarEnabled) {
    return c.json<TaskResponse>({ status: 'success' }, 200);
  }
  const state = await readClusterState();
  if (state.lastScanAt) {
    const ageMs = Date.now() - Date.parse(state.lastScanAt);
    const minAgeMs = settings.clusterScanIntervalMin * 60 * 1000;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < minAgeMs) {
      return c.json<TaskResponse>({ status: 'success' }, 200);
    }
  }
  const result = await runClusterScan();
  console.log(
    `[modradar] cluster-scan scanned=${result.scanned} clusters=${result.clusters}`
  );
  return c.json<TaskResponse>({ status: 'success' }, 200);
});
