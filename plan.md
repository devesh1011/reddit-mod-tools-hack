# ModRadar — Technical Implementation Plan

## Context

ModRadar is a Devvit Web application that gives Reddit moderators a pattern-detection layer across their modqueue. Three modules: Edit Radar (detects spam injected into edits), Collision Shield (prevents mods from duplicating work on same items), and Cluster Radar (surfaces brigades and coordinated spam across items). Built for the Reddit Mod Tools Hackathon. All code runs inside Devvit's hosted runtime — no external backend, no database other than Devvit Redis.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Devvit Runtime                       │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ Triggers │  │Scheduler │  │      Realtime         │  │
│  │(onPost   │  │(every 5m)│  │(mod-collision channel)│  │
│  │ Update,  │  │          │  │                       │  │
│  │ onComment│  │          │  │                       │  │
│  │ Update)  │  │          │  │                       │  │
│  └────┬─────┘  └────┬─────┘  └───────────┬───────────┘  │
│       │             │                    │              │
│  ┌────┴─────────────┴────────────────────┴───────────┐  │
│  │              Server (Hono)                        │  │
│  │  src/server/                                      │  │
│  │  ├── index.ts          (app bootstrap + routes)   │  │
│  │  ├── edit-radar.ts     (Module 1)                 │  │
│  │  ├── collision-shield.ts (Module 2)               │  │
│  │  ├── cluster-radar.ts  (Module 3)                 │  │
│  │  ├── settings.ts       (settings form handlers)   │  │
│  │  ├── url-scorer.ts     (domain reputation)        │  │
│  │  ├── diff-engine.ts    (text diff + URL extract)  │  │
│  │  ├── clustering.ts     (fuzzy grouping logic)     │  │
│  │  └── redis-schema.ts   (key conventions + types)  │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                               │
│  ┌──────────────────────┴────────────────────────────┐  │
│  │              Redis (Devvit KV)                    │  │
│  │  - Post/comment snapshots (hash, 30d TTL)         │  │
│  │  - URL reputation cache (hash, persistent)        │  │
│  │  - Modqueue cluster state (sorted set, transient) │  │
│  │  - Collision state (string, short TTL)            │  │
│  │  - App settings per subreddit (hash, persistent)  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Client (custom post dashboard)         │   │
│  │  src/client/                                     │   │
│  │  ├── index.html            (dashboard shell)     │   │
│  │  ├── dashboard.ts          (main UI logic)       │   │
│  │  ├── components/           (web components)      │   │
│  │  │   ├── cluster-card.ts   (cluster detail)      │   │
│  │  │   ├── settings-panel.ts (config UI)           │   │
│  │  │   └── diff-viewer.ts    (edit diff display)   │   │
│  │  └── styles.css                                  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## devvit.json Configuration

```json
{
  "$schema": "https://developers.reddit.com/schema/config-file.v1.json",
  "name": "modradar",
  "displayName": "ModRadar",
  "description": "Pattern detection layer for Reddit mods — catches spam edits, ban-evaders, and brigade reports that single-item review misses.",
  "post": {
    "dir": "dist/client",
    "entrypoints": {
      "default": {
        "entry": "index.html",
        "height": "tall"
      }
    }
  },
  "server": {
    "dir": "dist/server",
    "entry": "index.js",
    "framework": "hono"
  },
  "permissions": {
    "redis": true,
    "reddit": {
      "enable": true,
      "scope": "moderator"
    },
    "http": {
      "enable": true,
      "domains": ["safebrowsing.googleapis.com"]
    }
  },
  "triggers": {
    "onPostUpdate": "/internal/triggers/post-update",
    "onCommentUpdate": "/internal/triggers/comment-update",
    "onPostSubmit": "/internal/triggers/post-submit",
    "onCommentSubmit": "/internal/triggers/comment-submit",
    "onAppInstall": "/internal/triggers/app-install",
    "onAppUpgrade": "/internal/triggers/app-upgrade"
  },
  "scheduler": {
    "tasks": {
      "clusterScan": "/internal/scheduler/cluster-scan"
    }
  },
  "menu": {
    "items": [
      {
        "label": "Open ModRadar Dashboard",
        "description": "View cluster reports and edit detection alerts",
        "forUserType": "moderator",
        "location": "subreddit",
        "endpoint": "/internal/menu/open-dashboard"
      },
      {
        "label": "ModRadar Settings",
        "description": "Configure sensitivity, time windows, and auto-actions",
        "forUserType": "moderator",
        "location": "subreddit",
        "endpoint": "/internal/menu/settings"
      }
    ]
  },
  "forms": {
    "settingsForm": "/internal/form/settings-submit"
  }
}
```

## Folder Structure

```
modradar/
├── devvit.json
├── package.json
├── tsconfig.json
├── src/
│   ├── client/
│   │   ├── index.html              # Dashboard shell
│   │   ├── dashboard.ts            # Main client logic
│   │   ├── components/
│   │   │   ├── cluster-card.ts     # Cluster detail web component
│   │   │   ├── settings-panel.ts   # Settings panel web component
│   │   │   └── diff-viewer.ts      # Side-by-side edit diff display
│   │   └── styles.css              # Dashboard styles
│   └── server/
│       ├── index.ts                # Hono app bootstrap, route registration
│       ├── edit-radar.ts           # Module 1: edit detection + diff
│       ├── collision-shield.ts     # Module 2: realtime mod presence
│       ├── cluster-radar.ts        # Module 3: cross-item clustering
│       ├── settings.ts             # Settings persistence + form handlers
│       ├── url-scorer.ts           # URL risk scoring engine
│       ├── diff-engine.ts          # Text comparison + URL extraction
│       ├── clustering.ts           # Fuzzy clustering algorithms
│       └── redis-schema.ts         # All Redis key patterns + type helpers
├── public/
│   └── icon.png                    # App icon (256x256)
└── tests/
    ├── diff-engine.test.ts
    ├── url-scorer.test.ts
    └── clustering.test.ts
```

## Redis Schema

All keys are namespaced per subreddit via `{subredditId}` prefix. Devvit Redis is partitioned per installation already, but explicit prefixing prevents cross-subreddit leakage within a single app install and makes cleanup deterministic.

### Module 1 — Edit Radar

```
Key: mr:{subredditId}:snapshot:{thingId}
Type: Hash
Fields:
  body          — full text at creation time
  bodyHash      — SHA-256 of body for quick equality check
  urls          — JSON array of URLs found at creation
  createdAt     — ISO 8601 timestamp
  authorId      — t2_xxx user ID
TTL: 30 days (2592000 seconds)

Key: mr:{subredditId}:editlog:{thingId}
Type: List (LPUSH for each edit event)
Value: JSON { timestamp, addedUrls: string[], removedUrls: string[], diffPreview: string }
TTL: 30 days

Key: mr:{subredditId}:urldomain:{domainHash}
Type: Hash
Fields:
  reportCount   — how many times reported
  lastSeen      — ISO timestamp
  installedSubs — count of installed subs that flagged
Purpose: cross-subreddit domain reputation (anonymous, no PII)
No TTL (persistent, garbage-collected on app uninstall)
```

### Module 2 — Collision Shield

```
Key: mr:{subredditId}:reviewing:{thingId}
Type: String
Value: "{modUsername}|{startedAt}"
TTL: 300 seconds (5 min — auto-clears stale locks)

Key: mr:{subredditId}:reviewing:set
Type: Set
Value: set of thingId currently being reviewed
TTL: no explicit TTL (cleaned by collision-shield.ts on disconnect)
```

### Module 3 — Cluster Radar

```
Key: mr:{subredditId}:cluster:state
Type: Hash
Fields:
  lastScanAt  — ISO timestamp
  lastScanId  — UUID for idempotency
Purpose: track scan state, prevent duplicate processing

Key: mr:{subredditId}:cluster:active
Type: Sorted Set
Score: cluster risk score (0.0-1.0)
Member: cluster ID (UUID)
TTL: 3600 seconds (1 hour — clusters auto-expire)

Key: mr:{subredditId}:cluster:data:{clusterId}
Type: Hash
Fields:
  reason       — "domain" | "author" | "timewindow" | "reporter" | "textsim"
  items        — JSON array of {thingId, type, permalink, authorName}
  summary      — human-readable description
  detectedAt   — ISO timestamp
  riskScore    — 0.0-1.0
TTL: 3600 seconds

Key: mr:{subredditId}:cluster:idem:{idempotencyKey}
Type: String
Value: "1"
TTL: 86400 seconds (24h — prevent re-processing same event)
```

### Settings

```
Key: mr:{subredditId}:settings
Type: Hash
Fields:
  editWindowHours       — how long after creation to watch edits (default: 24)
  minDomainRiskScore    — threshold for flagging (0.0-1.0, default: 0.5)
  autoRemoveThreshold   — score above which to auto-remove (0.0-1.0, default: 0.9, 0 = disabled)
  clusterScanIntervalMin — minutes between cluster scans (default: 5)
  clusterMinGroupSize   — minimum items to form a cluster (default: 3)
  collisionShieldEnabled — boolean (default: true)
  editRadarEnabled       — boolean (default: true)
  clusterRadarEnabled    — boolean (default: true)
  notificationLevel      — "all" | "high" | "critical" (default: "high")
No TTL (persistent)
```

## Module 1 — Edit Radar (Detailed)

### Flow

1. `onPostSubmit` / `onCommentSubmit` trigger fires
2. `edit-radar.ts` handler receives event → extracts `post.id` or `comment.id`, `body`, `author.id`
3. Calls `reddit.getPostById(id)` or `reddit.getCommentById(id)` to get full body text
4. `diff-engine.ts` extracts all external URLs from body via regex: `/(?:https?:\/\/)?([\w.-]+(?:\.[\w\.-]+)+[\w\-\._~:\/?#[\]@!\$&'\(\)\*\+,;=.]+)/gi`
5. Stores snapshot in Redis: `HSET mr:{subredditId}:snapshot:{thingId} body "..." bodyHash "..." urls "[...]" createdAt "..." authorId "..."`
6. Sets TTL: `EXPIRE mr:{subredditId}:snapshot:{thingId} 2592000`

**On edit** (`onPostUpdate` / `onCommentUpdate`):

1. Trigger fires with updated `post` or `comment` object
2. Handler fetches current full body via `reddit.getPostById(id)` / `reddit.getCommentById(id)`
3. Reads Redis snapshot: `HGETALL mr:{subredditId}:snapshot:{thingId}`
4. If no snapshot exists (item predates app install), create snapshot from current body, return — no edit to flag
5. Compare body hashes — if equal, skip (no meaningful edit)
6. `diff-engine.ts` computes:
   - Full text diff (line-by-line, using Myers diff algorithm implemented in pure TypeScript)
   - Extracts URLs from old body and new body
   - Computes added URLs (`newUrls - oldUrls`) and removed URLs (`oldUrls - newUrls`)
7. If no new URLs added → log edit but don't flag (mods only care about URL injection)
8. For each new URL:
   - `url-scorer.ts` resolves redirects via `fetch()` (max 3 redirects, 30s timeout)
   - Extracts domain, checks against local Redis cache `mr:{subredditId}:urldomain:{domainHash}`
   - Checks Google Safe Browsing API if domain configured and approved
   - Computes composite risk score: domain age heuristic (newer domain = higher risk) + Safe Browsing match + prior reports across installed subs
9. If risk score >= `minDomainRiskScore`:
   - Reports to modqueue via `reddit.report(thingId, { reason: "ModRadar: suspicious link added in edit — {url} (risk: {score})" })`
   - If score >= `autoRemoveThreshold` AND `autoRemoveThreshold > 0`: calls `reddit.remove(thingId, true)` (spam), adds modlog entry
   - Pushes edit event to `mr:{subredditId}:editlog:{thingId}` with LPUSH
   - Sends realtime event to dashboard channel: `realtime.send("modradar:{subredditId}:alerts", { type: "edit-alert", thingId, urls: addedUrls, riskScore })`
10. Updates snapshot in Redis with new body content

### Time Window Check

```typescript
function isWithinEditWindow(createdAt: string, windowHours: number): boolean {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  return (now - created) <= windowMs;
}
```

If `isWithinEditWindow` returns false, skip processing — this implements the "only flag edits within X hours of creation" feature that AutoModerator lacks.

### Idempotency

Triggers may fire more than once. Before processing, check Redis:
```
EXISTS mr:{subredditId}:cluster:idem:edit:{thingId}:{bodyHash}
```
If exists, skip. If not, set it with 60s TTL.

### URL Extraction (diff-engine.ts)

```typescript
const URL_PATTERN = /(?:https?:\/\/)?([\w.-]+(?:\.[\w\.-]+)+[\w\-\._~:\/?#[\]@!\$&'\(\)\*\+,;=.]+)/gi;

function extractUrls(text: string): string[] {
  const matches = text.matchAll(URL_PATTERN);
  const urls: string[] = [];
  for (const match of matches) {
    try {
      const url = new URL(match[0].startsWith('http') ? match[0] : `https://${match[0]}`);
      urls.push(url.href);
    } catch {
      // skip invalid URLs
    }
  }
  return [...new Set(urls)];
}
```

### URL Risk Scoring (url-scorer.ts)

Composite score from:
1. **Domain age heuristic** (weight: 0.3): Newly registered domains (<30 days) = score 1.0, <90 days = 0.7, <365 days = 0.3, older = 0.0. Uses WHOIS-free heuristic: short domain name length + uncommon TLDs as proxy when fetch unavailable.
2. **Prior reports** (weight: 0.4): Check `mr:{subredditId}:urldomain:{domainHash}` — more reports across subs = higher score. Normalize 0-1 based on report count.
3. **Safe Browsing** (weight: 0.3): If HTTP fetch to Google Safe Browsing API is approved, check domain. Match = score 1.0.
4. **Shortener detection** (multiplier 1.5x): Known URL shorteners (bit.ly, tinyurl.com, t.co, ow.ly, etc.) multiply score by 1.5.

Final score = min(1.0, (d * 0.3 + r * 0.4 + s * 0.3) * shortenerMultiplier).

## Module 2 — Collision Shield (Detailed)

### Flow

1. Mod opens a post/comment via menu action or from dashboard
2. Server endpoint `POST /internal/menu/review-item` receives request with `thingId`
3. `collision-shield.ts`:
   - Checks `EXISTS mr:{subredditId}:reviewing:{thingId}`
   - If exists → returns response showing who is reviewing: `{ collision: true, reviewer: "u/othermod", startedAt: "..." }`
   - If not → Sets `mr:{subredditId}:reviewing:{thingId}` with `{modUsername}|{now}` and 300s TTL
   - Adds to `mr:{subredditId}:reviewing:set` via SADD
   - Broadcasts via `realtime.send("modradar:{subredditId}:reviewing", { type: "review-started", thingId, modUsername })`
4. Client subscribes to `modradar:{subredditId}:reviewing` channel via `connectRealtime()`
5. When another mod views modqueue, client highlights items currently being reviewed with badge showing mod username

### Heartbeat

Client sends `POST /api/review-heartbeat` every 60s while mod has item open. Server extends TTL on `mr:{subredditId}:reviewing:{thingId}` by another 300s. If heartbeat stops, lock auto-expires.

### Release

When mod navigates away or closes item, client calls `POST /api/review-release` with `thingId`. Server:
- Deletes `mr:{subredditId}:reviewing:{thingId}`
- Removes from set: `SREM mr:{subredditId}:reviewing:set {thingId}`
- Broadcasts `realtime.send("modradar:{subredditId}:reviewing", { type: "review-ended", thingId })`

### Cleanup

Scheduler task runs every 10 minutes:
- `SMEMBERS mr:{subredditId}:reviewing:set` → for each thingId:
  - `GET mr:{subredditId}:reviewing:{thingId}` → if null (expired), `SREM` it from set

### API Endpoints

```
POST /api/review-start       — body: {thingId} → returns {collision: bool, reviewer?: string}
POST /api/review-heartbeat   — body: {thingId} → extends TTL
POST /api/review-release     — body: {thingId} → clears lock
GET  /api/review-active       — returns {items: [{thingId, reviewer, startedAt}]}
```

## Module 3 — Cluster Radar (Detailed)

### Flow

1. Scheduler fires `clusterScan` task every 5 minutes (configurable via settings)
2. `cluster-radar.ts` handler:
   - Checks `mr:{subredditId}:cluster:state` → if last scan was <4 min ago AND no new reports since, skip
   - Sets `lastScanAt` to now
3. Gathers data:
   - Fetches recent modqueue items via `reddit.getModQueue()` equivalent (iterates subreddit modqueue)
   - For each item, reads snapshot from Redis: `HGETALL mr:{subredditId}:snapshot:{thingId}`
   - Builds in-memory item list with fields: `{thingId, type, authorId, permalink, urls[], createdAt, bodyHash, subredditId}`
4. `clustering.ts` runs four parallel grouping passes:

   **Pass A — Shared Domain:**
   - Group items where any URL domain overlaps
   - Minimum group size: 3

   **Pass B — Shared Author:**
   - Group items by same `authorId`
   - Minimum group size: 3 items from same author in past 24h

   **Pass C — Time Window + URL:**
   - Group items created within 10-minute window that share same URL domain
   - This catches coordinated link-dropping campaigns

   **Pass D — Reporter Correlation:**
   - Group items where same set of reporters reported multiple items
   - Detects brigaded reporting (multiple reports on same content from coordinated accounts)

5. For each cluster found:
   - Computes risk score based on: group size, account age (newer = higher), domain reputation, time density
   - Stores in Redis: `HSET mr:{subredditId}:cluster:data:{clusterId} ...` with 1h TTL
   - Adds to sorted set: `ZADD mr:{subredditId}:cluster:active {riskScore} {clusterId}`
6. Creates a custom post (dashboard) if one doesn't exist for current scan window, or updates existing via `postData`:
   ```typescript
   await reddit.submitCustomPost({
     subredditName: subredditName,
     title: `ModRadar Cluster Report — ${new Date().toISOString().slice(0, 10)}`,
     entry: 'default',
   });
   ```
   Then stores cluster data in `postData` for client to render.

### Clustering Algorithm (clustering.ts)

```typescript
interface ModqueueItem {
  thingId: string;
  type: 'post' | 'comment';
  authorId: string;
  authorCreatedAt: string; // account creation date
  permalink: string;
  urls: string[];
  createdAt: string;
  bodyHash: string;
  reporterIds: string[]; // if reported
}

interface Cluster {
  id: string;
  reason: 'domain' | 'author' | 'timewindow' | 'reporter';
  items: ModqueueItem[];
  riskScore: number;
  summary: string;
}

function clusterByDomain(items: ModqueueItem[], minGroupSize: number): Cluster[] {
  const domainMap = new Map<string, ModqueueItem[]>();
  for (const item of items) {
    for (const url of item.urls) {
      try {
        const domain = new URL(url).hostname;
        const existing = domainMap.get(domain) || [];
        existing.push(item);
        domainMap.set(domain, existing);
      } catch { /* skip malformed */ }
    }
  }
  return [...domainMap.entries()]
    .filter(([_, group]) => group.length >= minGroupSize)
    .map(([domain, group]) => ({
      id: crypto.randomUUID(),
      reason: 'domain' as const,
      items: group,
      riskScore: computeRiskScore(group),
      summary: `${group.length} items linking to ${domain}`,
    }));
}

function computeRiskScore(items: ModqueueItem[]): number {
  const now = Date.now();
  let score = 0;
  // Account age: newer accounts = higher risk
  for (const item of items) {
    const accountAge = (now - new Date(item.authorCreatedAt).getTime()) / 86400000;
    if (accountAge < 30) score += 0.3;
    else if (accountAge < 90) score += 0.2;
    else if (accountAge < 365) score += 0.1;
  }
  // Group size factor
  score += Math.min(0.5, items.length * 0.1);
  // Time density: items closer together = higher risk
  if (items.length >= 2) {
    const timestamps = items.map(i => new Date(i.createdAt).getTime()).sort();
    const span = (timestamps[timestamps.length - 1] - timestamps[0]) / 60000;
    if (span < 10) score += 0.3;
    else if (span < 60) score += 0.1;
  }
  return Math.min(1.0, score);
}
```

### Dashboard Client (src/client/dashboard.ts)

Dashboard is a custom post that renders cluster data. On load:
1. Client calls `GET /api/dashboard-data` → returns JSON of active clusters and recent edit alerts
2. Renders cluster cards sorted by risk score descending
3. Each card shows: reason, item count, summary, per-item links, risk score badge
4. One-click "Remove All" button sends `POST /api/bulk-action` with `{clusterId, action: "remove"}` → server iterates items, calls `reddit.remove()` for each, adds modlog entry

## Server Entry Point (src/server/index.ts)

```typescript
import { Hono } from 'hono';
import { realtime, scheduler, redis, reddit, context } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import { handlePostUpdate, handlePostSubmit, handleCommentUpdate, handleCommentSubmit } from './edit-radar.js';
import { handleClusterScan } from './cluster-radar.js';
import { handleSettingsForm, showSettingsForm } from './settings.js';
import { reviewStart, reviewHeartbeat, reviewRelease, reviewActive } from './collision-shield.js';
import { getDashboardData, handleBulkAction } from './cluster-radar.js';

const app = new Hono();

// === Triggers ===
app.post('/internal/triggers/post-submit', async (c) => {
  const input = await c.req.json();
  await handlePostSubmit(input);
  return c.json<TriggerResponse>({ status: 'ok' });
});

app.post('/internal/triggers/comment-submit', async (c) => {
  const input = await c.req.json();
  await handleCommentSubmit(input);
  return c.json<TriggerResponse>({ status: 'ok' });
});

app.post('/internal/triggers/post-update', async (c) => {
  const input = await c.req.json();
  await handlePostUpdate(input);
  return c.json<TriggerResponse>({ status: 'ok' });
});

app.post('/internal/triggers/comment-update', async (c) => {
  const input = await c.req.json();
  await handleCommentUpdate(input);
  return c.json<TriggerResponse>({ status: 'ok' });
});

app.post('/internal/triggers/app-install', async (c) => {
  // Initialize default settings in Redis
  const { subredditId } = context;
  await redis.hSet(`mr:${subredditId}:settings`, {
    editWindowHours: '24',
    minDomainRiskScore: '0.5',
    autoRemoveThreshold: '0',
    clusterScanIntervalMin: '5',
    clusterMinGroupSize: '3',
    collisionShieldEnabled: 'true',
    editRadarEnabled: 'true',
    clusterRadarEnabled: 'true',
    notificationLevel: 'high',
  });
  // Schedule first cluster scan
  await scheduler.runJob({
    id: `cluster-scan-${subredditId}-init`,
    name: 'clusterScan',
    data: { subredditId },
    runAt: new Date(Date.now() + 300000), // 5 min after install
  });
  return c.json<TriggerResponse>({ status: 'ok' });
});

app.post('/internal/triggers/app-upgrade', async (c) => {
  return c.json<TriggerResponse>({ status: 'ok' });
});

// === Scheduler ===
app.post('/internal/scheduler/cluster-scan', async (c) => {
  const input = await c.req.json();
  await handleClusterScan(input);
  return c.json<TriggerResponse>({ status: 'ok' });
});

// === Menu Actions ===
app.post('/internal/menu/open-dashboard', async (c) => {
  const { subredditName } = context;
  await reddit.submitCustomPost({
    subredditName: subredditName!,
    title: `ModRadar Dashboard — ${new Date().toISOString().slice(0, 10)}`,
    entry: 'default',
  });
  return c.json<UiResponse>({ showToast: { text: 'Dashboard opened!', appearance: 'success' } });
});

app.post('/internal/menu/settings', async (c) => {
  return showSettingsForm(c);
});

// === Forms ===
app.post('/internal/form/settings-submit', async (c) => {
  return handleSettingsForm(c);
});

// === API Endpoints (called by client) ===
app.post('/api/review-start', async (c) => reviewStart(c));
app.post('/api/review-heartbeat', async (c) => reviewHeartbeat(c));
app.post('/api/review-release', async (c) => reviewRelease(c));
app.get('/api/review-active', async (c) => reviewActive(c));
app.get('/api/dashboard-data', async (c) => getDashboardData(c));
app.post('/api/bulk-action', async (c) => handleBulkAction(c));

export default app;
```

## Settings System

### Settings Form

Settings use Devvit's form system. The `showSettingsForm` handler returns a `UiResponse` with `showForm` containing:

- `editWindowHours` (number, 1-720): Hours after creation to watch edits
- `minDomainRiskScore` (number, 0.0-1.0, step 0.1): Minimum risk score to flag
- `autoRemoveThreshold` (number, 0.0-1.0, step 0.1, 0 = disabled): Auto-remove above this score
- `clusterMinGroupSize` (number, 2-10): Minimum items to form a cluster
- `clusterScanIntervalMin` (number, 1-60): Minutes between cluster scans
- `collisionShieldEnabled` (boolean)
- `editRadarEnabled` (boolean)
- `clusterRadarEnabled` (boolean)
- `notificationLevel` (select: "all" | "high" | "critical")

On submit: `HSET mr:{subredditId}:settings` with all values.

## API Reference

### Client → Server (fetch from dashboard)

| Method | Endpoint | Request Body | Response |
|--------|----------|-------------|----------|
| GET | `/api/dashboard-data` | — | `{ clusters: Cluster[], alerts: Alert[], lastScanAt: string }` |
| POST | `/api/bulk-action` | `{ clusterId: string, action: "remove" \| "report" \| "ignore" }` | `{ success: boolean, affected: number }` |
| POST | `/api/review-start` | `{ thingId: string }` | `{ collision: boolean, reviewer?: string }` |
| POST | `/api/review-heartbeat` | `{ thingId: string }` | `{ ok: true }` |
| POST | `/api/review-release` | `{ thingId: string }` | `{ ok: true }` |
| GET | `/api/review-active` | — | `{ items: {thingId, reviewer, startedAt}[] }` |
| GET | `/api/settings` | — | `Settings` (all fields) |

### Realtime Channels

| Channel | Direction | Message Types |
|---------|-----------|---------------|
| `modradar:{subredditId}:reviewing` | Server → Client | `review-started`, `review-ended` |
| `modradar:{subredditId}:alerts` | Server → Client | `edit-alert`, `cluster-alert`, `bulk-action-complete` |

## Package Dependencies

```json
{
  "private": true,
  "name": "modradar",
  "version": "1.0.0",
  "license": "BSD-3-Clause",
  "type": "module",
  "scripts": {
    "deploy": "devvit upload",
    "dev": "dotenv -e .env -- devvit playtest",
    "login": "devvit login",
    "launch": "devvit publish",
    "type-check": "tsc --build",
    "test": "vitest run"
  },
  "dependencies": {
    "@devvit/public-api": "0.12.2",
    "hono": "^4"
  },
  "devDependencies": {
    "devvit": "0.12.2",
    "dotenv-cli": "8.0.0",
    "typescript": "5.8.3",
    "vitest": "^3"
  }
}
```

## Build Plan (24-hour hackathon)

| Hour | Task | Files Touched |
|------|------|--------------|
| 0–1 | `devvit new modradar`, scaffold folder structure, configure devvit.json, install deps | devvit.json, package.json, tsconfig.json |
| 1–3 | **Module 1 core**: `diff-engine.ts` URL extraction + body hashing, `redis-schema.ts` snapshot write on submit triggers | src/server/diff-engine.ts, src/server/redis-schema.ts, src/server/edit-radar.ts (submit handlers) |
| 3–5 | **Module 1 detection**: `url-scorer.ts` domain scoring, edit trigger handler with diff + URL compare + report to modqueue | src/server/url-scorer.ts, src/server/edit-radar.ts (update handlers) |
| 5–6 | **Module 1 polish**: time window check, idempotency guard, edit log recording | src/server/edit-radar.ts |
| 6–8 | **Module 2**: Realtime channel setup, `collision-shield.ts` lock/release/heartbeat, client review-active polling | src/server/collision-shield.ts, src/server/index.ts |
| 8–11 | **Module 3 core**: `clustering.ts` algorithm (domain + author + timewindow passes), scheduler task handler | src/server/clustering.ts, src/server/cluster-radar.ts |
| 11–14 | **Module 3 dashboard**: client HTML/TS, cluster card component, bulk action handler | src/client/* |
| 14–16 | **Settings**: form creation, settings persistence, settings panel UI in client | src/server/settings.ts, src/client/components/settings-panel.ts |
| 16–18 | **Integration**: wire all routes in index.ts, end-to-end test on test subreddit, fix bugs | src/server/index.ts |
| 18–20 | **Testing**: create test posts with edits, simulate collisions, verify cluster detection | tests/* |
| 20–22 | **Polish**: app icon, app listing page on developers.reddit.com, screenshots, install GIF | public/icon.png |
| 22–24 | **Submission**: Devpost writeup, 60s video demo, impact statement | — |

## Policy Compliance

- No PII stored — only post/comment IDs, content hashes, URL lists
- No cross-subreddit user tracking — cluster radar works within single subreddit's modqueue
- Ban-evasion signals derived from in-sub behavior patterns, not cross-sub participation (avoids March 2026 policy line)
- All Redis keys have TTL (30 days for snapshots, 1 hour for cluster data)
- Data deletion on post/comment delete: hook `onPostDelete`/`onCommentDelete` triggers → delete snapshot + editlog keys
- No user profiling — domain reputation is anonymous (domain hash only, no author data attached)
- App description clearly states automated actions (reporting, optional auto-remove)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Devvit request timeout (30s) on large modqueues | Cluster scan processes in batches of 50, stores cursor in Redis, resumes next scheduler tick |
| Trigger duplicate delivery | Idempotency key in Redis (60s TTL per bodyHash) before processing |
| Realtime channel unavailable | Collision Shield falls back to polling `GET /api/review-active` every 30s |
| Redis write quota exceeded on large subs | Bloom filter: only snapshot posts with >5 karma OR >3 comments. Comments only if author account <30 days |
| Safe Browsing API not approved | Falls back to local domain-age heuristic (TLD risk tables + shortener detection) |
| 24h too tight for all 3 modules | Ship priority: Module 1 → Module 2 → Module 3. Module 1 alone is demo-worthy |

## Verification Plan

1. **Install on test subreddit**: `npm run dev` → verify app installs, menu items appear
2. **Edit Radar test**: Create post → edit post to add `bit.ly/xyz` link → verify modqueue report appears with risk score
3. **Time window test**: Create post → wait >24h → edit to add link → verify NO report (window expired)
4. **Collision Shield test**: Open item in dashboard → verify `/api/review-active` shows it → second mod sees collision badge
5. **Cluster Radar test**: Create 3 comments from 3 new accounts all linking to same domain → wait for scheduler tick → verify cluster appears in dashboard
6. **Bulk action test**: Click "Remove All" on cluster → verify all items removed, modlog entries created
7. **Settings test**: Change `editWindowHours` to 48 → create post → edit at 30h → verify report still fires
8. **Edge cases**: Empty body, body with no URLs, malformed URLs, concurrent edits on same item, trigger for own app's actions (skip self)
