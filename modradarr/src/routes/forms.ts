import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { isT1, isT3 } from '@devvit/shared-types/tid.js';
import { handleNuke, handleNukePost } from '../core/nuke';
import { readSettings, writeSettings, type Settings } from '../core/redis-schema';

type NukeFormValues = {
  remove?: boolean;
  lock?: boolean;
  skipDistinguished?: boolean;
  targetId?: string;
};

export const forms = new Hono();

const normalizeValues = (values: NukeFormValues) => ({
  remove: Boolean(values.remove),
  lock: Boolean(values.lock),
  skipDistinguished: Boolean(values.skipDistinguished),
});

const getTargetId = (values: NukeFormValues) => {
  if (typeof values.targetId === 'string' && values.targetId.trim()) {
    return values.targetId.trim();
  }

  return context.postId;
};

forms.post('/mop-comment-submit', async (c) => {
  const values = await c.req.json<NukeFormValues>();
  console.log('values', values);
  const normalized = normalizeValues(values);

  if (!normalized.lock && !normalized.remove) {
    return c.json<UiResponse>(
      {
        showToast: 'You must select either lock or remove.',
      },
      200
    );
  }

  const targetId = getTargetId(values);
  if (!isT1(targetId)) {
    console.error('targetId is not a T1', targetId);
    return c.json<UiResponse>(
      {
        showToast: 'Mop failed! Please try again later.',
      },
      200
    );
  }

  const result = await handleNuke({
    ...normalized,
    commentId: targetId,
    subredditId: context.subredditId,
  });

  console.log(
    `Mop result - ${result.success ? 'success' : 'fail'} - ${result.message}`
  );

  return c.json<UiResponse>(
    {
      showToast: `${result.success ? 'Success' : 'Failed'} : ${result.message}`,
    },
    200
  );
});

type SettingsFormValues = {
  editWindowHours?: number | string;
  minDomainRiskScore?: number | string;
  autoRemoveThreshold?: number | string;
  clusterMinGroupSize?: number | string;
  editRadarEnabled?: boolean;
  collisionShieldEnabled?: boolean;
  clusterRadarEnabled?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function asNumber(input: number | string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const n = typeof input === 'number' ? input : Number.parseFloat(input);
  return Number.isFinite(n) ? n : fallback;
}

forms.post('/modradar-settings-submit', async (c) => {
  const values = await c.req.json<SettingsFormValues>().catch(() => ({}) as SettingsFormValues);
  const current = await readSettings();

  const next: Settings = {
    editWindowHours: clamp(
      Math.round(asNumber(values.editWindowHours, current.editWindowHours)),
      1,
      720
    ),
    minDomainRiskScore: clamp(asNumber(values.minDomainRiskScore, current.minDomainRiskScore), 0, 1),
    autoRemoveThreshold: clamp(asNumber(values.autoRemoveThreshold, current.autoRemoveThreshold), 0, 1),
    clusterMinGroupSize: clamp(
      Math.round(asNumber(values.clusterMinGroupSize, current.clusterMinGroupSize)),
      2,
      20
    ),
    editRadarEnabled: values.editRadarEnabled ?? current.editRadarEnabled,
    collisionShieldEnabled: values.collisionShieldEnabled ?? current.collisionShieldEnabled,
    clusterRadarEnabled: values.clusterRadarEnabled ?? current.clusterRadarEnabled,
  };

  if (next.autoRemoveThreshold > 0 && next.autoRemoveThreshold < next.minDomainRiskScore) {
    return c.json<UiResponse>(
      {
        showToast: `Auto-remove (${next.autoRemoveThreshold.toFixed(2)}) cannot be below alert threshold (${next.minDomainRiskScore.toFixed(2)}). Not saved.`,
      },
      200
    );
  }

  await writeSettings(next);

  const changed: (keyof Settings)[] = [];
  (Object.keys(next) as (keyof Settings)[]).forEach((key) => {
    if (next[key] !== current[key]) changed.push(key);
  });

  const summary =
    changed.length === 0
      ? 'ModRadar: no changes.'
      : `ModRadar: saved ${changed.length} change${changed.length === 1 ? '' : 's'}.`;

  console.log(
    `[modradar] settings saved by ${context.userId ?? 'unknown'} — ${
      changed.length === 0
        ? 'no diff'
        : changed.map((k) => `${k}=${String(next[k])}`).join(', ')
    }`
  );

  return c.json<UiResponse>({ showToast: summary }, 200);
});

forms.post('/mop-post-submit', async (c) => {
  const values = await c.req.json<NukeFormValues>();
  console.log('values', values);
  const normalized = normalizeValues(values);

  if (!normalized.lock && !normalized.remove) {
    return c.json<UiResponse>(
      {
        showToast: 'You must select either lock or remove.',
      },
      200
    );
  }

  const targetId = getTargetId(values);
  if (!isT3(targetId)) {
    console.error('targetId is not a T3', targetId);
    return c.json<UiResponse>(
      {
        showToast: 'Mop failed! Please try again later.',
      },
      200
    );
  }

  const result = await handleNukePost({
    ...normalized,
    postId: targetId,
    subredditId: context.subredditId,
  });

  console.log(
    `Mop result - ${result.success ? 'success' : 'fail'} - ${result.message}`
  );

  return c.json<UiResponse>(
    {
      showToast: `${result.success ? 'Success' : 'Failed'} : ${result.message}`,
    },
    200
  );
});
