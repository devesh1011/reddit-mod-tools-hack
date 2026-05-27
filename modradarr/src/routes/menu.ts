import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import type { FormField } from '@devvit/shared-types/shared/form.js';
import {
  clearDashboardPostId,
  getDashboardPostId,
  readAlert,
  readSettings,
  recentAlertIds,
  setDashboardPostId,
} from '../core/redis-schema';
import {
  acquireReview,
  formatElapsed,
  listActiveLocks,
  peekReview,
  releaseReview,
} from '../core/collision-shield';

export const menu = new Hono();

const buildNukeFields = (targetId: string): FormField[] => [
  {
    name: 'targetId',
    label: 'Target ID',
    type: 'string',
    helpText: 'Auto-filled from the selected item.',
    required: true,
    defaultValue: targetId,
  },
  {
    name: 'remove',
    label: 'Remove comments',
    type: 'boolean',
    defaultValue: true,
  },
  {
    name: 'lock',
    label: 'Lock comments',
    type: 'boolean',
    defaultValue: false,
  },
  {
    name: 'skipDistinguished',
    label: 'Skip distinguished comments',
    type: 'boolean',
    defaultValue: false,
  },
];

const buildNukeForm = (title: string, targetId: string) => ({
  fields: buildNukeFields(targetId),
  title,
  acceptLabel: 'Mop',
  cancelLabel: 'Cancel',
});

menu.post('/mop-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('request', request.targetId);
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'mopComment',
        form: buildNukeForm('Mop Comments', request.targetId),
      },
    },
    200
  );
});

menu.post('/mop-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'mopPost',
        form: buildNukeForm('Mop Post Comments', request.targetId),
      },
    },
    200
  );
});

async function toggleReviewLock(targetId: string): Promise<UiResponse> {
  const settings = await readSettings();
  if (!settings.collisionShieldEnabled) {
    return { showToast: 'ModRadar: Collision Shield is disabled in settings.' };
  }
  const user = await reddit.getCurrentUser();
  const username = user?.username;
  if (!username) {
    return { showToast: 'ModRadar: could not identify current mod.' };
  }

  const existing = await peekReview(targetId);
  if (existing && existing.reviewer !== username) {
    return {
      showToast: `ModRadar: u/${existing.reviewer} is reviewing this (started ${formatElapsed(existing.startedAt)}).`,
    };
  }

  if (existing && existing.reviewer === username) {
    const result = await releaseReview(targetId, username);
    if (result.kind === 'released') {
      return { showToast: 'ModRadar: review lock released.' };
    }
    return { showToast: 'ModRadar: no lock held by you.' };
  }

  const result = await acquireReview(targetId, username);
  if (result.kind === 'acquired') {
    return {
      showToast: 'ModRadar: locked for your review (auto-releases in 5 min).',
    };
  }
  if (result.kind === 'extended') {
    return { showToast: 'ModRadar: lock heartbeat — still yours for 5 more min.' };
  }
  return {
    showToast: `ModRadar: u/${result.existing.reviewer} is reviewing this (started ${formatElapsed(result.existing.startedAt)}).`,
  };
}

menu.post('/modradar-review-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const response = await toggleReviewLock(request.targetId);
  return c.json<UiResponse>(response, 200);
});

menu.post('/modradar-review-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const response = await toggleReviewLock(request.targetId);
  return c.json<UiResponse>(response, 200);
});

menu.post('/modradar-active-locks', async (c) => {
  const settings = await readSettings();
  if (!settings.collisionShieldEnabled) {
    return c.json<UiResponse>(
      { showToast: 'ModRadar: Collision Shield is disabled in settings.' },
      200
    );
  }
  const locks = await listActiveLocks();
  if (locks.length === 0) {
    return c.json<UiResponse>({ showToast: 'ModRadar: no active review locks.' }, 200);
  }
  const summary = locks
    .slice(0, 5)
    .map((l) => `${l.thingId} → u/${l.reviewer} (${formatElapsed(l.startedAt)})`)
    .join(' | ');
  return c.json<UiResponse>(
    { showToast: `ModRadar: ${locks.length} active lock(s). ${summary}` },
    200
  );
});

menu.post('/modradar-settings', async (c) => {
  const settings = await readSettings();
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'modradarSettings',
        form: {
          title: 'ModRadar Settings',
          acceptLabel: 'Save',
          cancelLabel: 'Cancel',
          fields: [
            {
              name: 'editWindowHours',
              label: 'Edit window (hours)',
              helpText: 'Only flag edits made within this many hours of creation.',
              type: 'number',
              defaultValue: settings.editWindowHours,
            },
            {
              name: 'minDomainRiskScore',
              label: 'Min risk score to alert (e.g. 0.5)',
              helpText: 'URLs scored at or above this threshold create an alert.',
              type: 'string',
              defaultValue: String(settings.minDomainRiskScore),
            },
            {
              name: 'autoRemoveThreshold',
              label: 'Auto-remove threshold (0 = disabled)',
              helpText: 'Score at or above this auto-removes the item as spam.',
              type: 'string',
              defaultValue: String(settings.autoRemoveThreshold),
            },
            {
              name: 'clusterMinGroupSize',
              label: 'Cluster minimum group size',
              helpText: 'Minimum items required to form a cluster.',
              type: 'number',
              defaultValue: settings.clusterMinGroupSize,
            },
            {
              name: 'clusterScanIntervalMin',
              label: 'Cluster scan interval (minutes)',
              helpText: 'Skip cron-triggered scans if last scan finished within this window.',
              type: 'number',
              defaultValue: settings.clusterScanIntervalMin,
            },
            {
              name: 'notificationLevel',
              label: 'Notifications (off / digest / realtime)',
              helpText: 'off = no alerts stored, digest = stored only, realtime = stored + dashboard push.',
              type: 'select',
              defaultValue: [settings.notificationLevel],
              options: [
                { label: 'off', value: 'off' },
                { label: 'digest', value: 'digest' },
                { label: 'realtime', value: 'realtime' },
              ],
            },
            {
              name: 'agentMode',
              label: 'LLM agent mode (off / borderline / always)',
              helpText: 'off = heuristic only. borderline = adjudicate scores in [0.3, 0.7]. always = call on every alert. Requires Anthropic API key.',
              type: 'select',
              defaultValue: [settings.agentMode],
              options: [
                { label: 'off', value: 'off' },
                { label: 'borderline', value: 'borderline' },
                { label: 'always', value: 'always' },
              ],
            },
            {
              name: 'editRadarEnabled',
              label: 'Edit Radar enabled',
              type: 'boolean',
              defaultValue: settings.editRadarEnabled,
            },
            {
              name: 'collisionShieldEnabled',
              label: 'Collision Shield enabled',
              type: 'boolean',
              defaultValue: settings.collisionShieldEnabled,
            },
            {
              name: 'clusterRadarEnabled',
              label: 'Cluster Radar enabled',
              type: 'boolean',
              defaultValue: settings.clusterRadarEnabled,
            },
          ],
        },
      },
    },
    200
  );
});

menu.post('/modradar-open-dashboard', async (c) => {
  const { subredditName } = context;
  if (!subredditName) {
    return c.json<UiResponse>(
      { showToast: 'ModRadar: subredditName missing from context.' },
      200
    );
  }

  const existingId = await getDashboardPostId();
  if (existingId) {
    try {
      const existing = await reddit.getPostById(existingId as `t3_${string}`);
      if (existing && !existing.removed) {
        return c.json<UiResponse>(
          {
            navigateTo: existing.permalink
              ? `https://www.reddit.com${existing.permalink}`
              : `https://www.reddit.com/r/${subredditName}/comments/${existingId.replace(/^t3_/, '')}/`,
            showToast: 'ModRadar: opening existing dashboard.',
          },
          200
        );
      }
    } catch (err) {
      console.warn('[modradar] stored dashboard post unreachable, recreating', err);
      await clearDashboardPostId();
    }
  }

  try {
    const post = await reddit.submitCustomPost({
      subredditName,
      title: `ModRadar Dashboard — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      entry: 'default',
    });
    await setDashboardPostId(post.id);
    return c.json<UiResponse>(
      {
        navigateTo: post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : `https://www.reddit.com/r/${subredditName}/comments/${post.id.replace(/^t3_/, '')}/`,
        showToast: `ModRadar dashboard posted: ${post.id}.`,
      },
      200
    );
  } catch (err) {
    console.error('[modradar] failed to submit dashboard post', err);
    return c.json<UiResponse>(
      { showToast: 'ModRadar: failed to create dashboard post.' },
      200
    );
  }
});

menu.post('/modradar-alerts', async (_c) => {
  const ids = await recentAlertIds(5);
  if (ids.length === 0) {
    return _c.json<UiResponse>({ showToast: 'ModRadar: no recent edit alerts.' }, 200);
  }
  const alerts = await Promise.all(ids.map((id) => readAlert(id)));
  const lines = alerts
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .map(
      (a) =>
        `${a.type[0]?.toUpperCase()}${a.thingId} risk=${a.riskScore.toFixed(2)} +${a.addedUrls.length}url${a.removed ? ' [REMOVED]' : ''}`
    );
  return _c.json<UiResponse>(
    { showToast: `ModRadar: ${lines.length} alert(s). ${lines.join(' | ')}` },
    200
  );
});
