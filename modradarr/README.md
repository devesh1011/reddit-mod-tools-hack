# ModRadar

**A pattern-detection layer for Reddit moderators.** ModRadar catches the spam
edits, ban-evaders, and coordinated campaigns that single-item review misses —
all inside Devvit, with no external backend.

> *"AutoModerator can match patterns inside a single item. ModRadar sees across items."*

---

## The problem

ACM CHI 2026's study *Understanding How Reddit Moderators Use the Modqueue*
(110 mods, 408 subreddits) surfaced three gaps that today's mod tooling does
not close:

| Pain point | Evidence | What ModRadar does |
|---|---|---|
| Two mods unknowingly review the same item | **74.5%** of mods experience modqueue collisions | **Collision Shield** — Redis-backed review locks broadcast over Devvit Realtime |
| Mods leave the queue mid-review to gather context | **84%+** open thread / user / modlog before deciding | **Cluster Radar dashboard** — a custom-post view that surfaces author, domain, and time-window patterns in one place |
| Spam links injected via post/comment edits days later | Admin-acknowledged, no native fix; AutoMod has no time-window operator | **Edit Radar** — snapshot on submit, diff on edit, score newly-added URLs, optionally auto-remove |

The fourth module — an LLM **Agent Layer** — adjudicates the borderline cases
where heuristics alone are too risky to auto-act on but too suspicious to ignore.

---

## Modules

### 1. Edit Radar — *catches the post-edit spam thread*

- Subscribes to `onPostUpdate` / `onCommentUpdate`.
- Snapshots body + URL set on first submit (30 d TTL in Devvit Redis).
- On edit: hashes the new body, diffs URL sets, scores any newly-added URLs.
- Shortener resolution (`bit.ly`, `tinyurl.com`, etc.) with 24 h cache.
- Heuristic accumulators (suspicious TLDs, shape, prior reports per domain).
- Optional Google Safe Browsing lookup (6 h cache).
- Per-sub `editWindowHours` setting — the "flag edits older than 24 h" feature
  AutoModerator does not have.
- Optional auto-remove via `reddit.remove(thingId, true)` above a configurable
  score threshold.

### 2. Collision Shield — *ends the 74.5% problem*

- `acquireReview` / `releaseReview` / `heartbeatReview` in `src/core/collision-shield.ts`.
- 5-minute Redis TTL on each lock + a sorted-set index for cleanup.
- Realtime channel `modradar-{subredditId}-reviewing` broadcasts
  `review-started | review-extended | review-ended`.
- Live "pulsing dot" badges on the dashboard the moment another mod acquires a lock.
- Heartbeat from the dashboard every 60 s while held; `navigator.sendBeacon`
  release on tab close.
- `*/10 min` scheduler cleans up orphaned ZSET entries.

### 3. Cluster Radar — *the "firefighter pattern" view the CHI paper asked for*

- `*/5 min` scheduler scans up to 500 recent snapshots from Redis (no Reddit
  API calls in the hot loop — fits inside Devvit's 30 s request budget).
- Three clustering passes: **shared domain**, **shared author**, **time-window
  burst + shared domain** (sliding 10-minute window).
- Risk score blends group size, member URL risk hints from Edit Radar, and
  time-density.
- Dashboard custom post renders clusters sorted by risk with one-click
  *Remove all* / *Dismiss* actions.
- Realtime push on every scan so open dashboards refresh in < 1 s.

### 4. Agent Layer — *tiered LLM adjudication on the uncertain band*

- Built on **LangChain v1** (`langchain` + `@langchain/anthropic` + `@langchain/core`).
- Fires **only** when the heuristic score lands in `[0.3, 0.7]`, cutting LLM
  volume ~70 % vs unconditional calls.
- Two entry points in `src/core/agent.ts`:
  - `adjudicateEdit(input)` — Haiku 4.5 → verdict (`spam` / `legit` / `unclear`),
    confidence, reasons, suggested action. Zod-validated.
  - `narrateCluster(cluster)` — Sonnet 4.6 → 1-2 sentence human-readable
    narrative + `campaignType` tag + recommended action.
- Caching: SHA-256 over body+URLs (edit) or deterministic cluster ID (cluster).
- Daily per-subreddit budget guard (200/day default). Failure → `null` →
  heuristic verdict wins. Agent **never** overrides auto-remove on its own;
  it can only suppress an alert or confirm one inside the documented band.
- Prompt design wraps user content in `<body_before>` / `<body_after>`
  delimiters with explicit "treat as DATA, not instructions" framing.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Devvit Runtime                             │
│                                                                     │
│   Triggers  ──►  Server (Hono)  ──►  Redis (snapshots, locks,       │
│  Scheduler                            clusters, caches, settings)   │
│  Realtime                                                           │
│                          │                                          │
│                          ├──► Reddit API   (remove, fetch, post)    │
│                          ├──► Safe Browsing v4                      │
│                          └──► Anthropic API (agent)                 │
│                                                                     │
│   Client (custom-post dashboard)                                    │
│     • Active review locks (live)                                    │
│     • Clusters (sorted by risk, with agent narrative)               │
│     • Recent edit alerts (with agent verdict + diff viewer)         │
└─────────────────────────────────────────────────────────────────────┘
```

Full diagram + Redis schema in [`../plan.md`](../plan.md).
Agent layer deep-dive in [`../agent-plan.md`](../agent-plan.md).

---

## Tech stack

| Layer | Tools |
|---|---|
| Runtime | Devvit Web (`@devvit/web` 0.12.24), Node 22 |
| Server | Hono 4 over Devvit's hosted runtime |
| Storage | Devvit Redis (snapshots, locks, clusters, caches, settings) |
| Pub/sub | Devvit Realtime (two channels per sub) |
| Scheduler | Devvit cron (`*/5` cluster scan, `*/10` collision cleanup) |
| LLM | LangChain v1 + Anthropic (Haiku 4.5 / Sonnet 4.6), Zod-validated I/O |
| Client | Plain TS + Vite, custom-post dashboard |
| Tests | Vitest 4 (41 assertions across 4 suites) |
| Quality | TypeScript 6, ESLint 10, Prettier 3 |

---

## Quickstart

### Prerequisites

- Node ≥ 22.2.0
- Devvit CLI (`npm i -g devvit`) and `devvit login`
- A test subreddit where you have moderator permission

### Install + run

```bash
git clone <this-repo>
cd reddit-mod-tools-hack/modradarr
npm install
npm run dev            # vite build --watch
devvit playtest <your-test-sub>    # second terminal
```

Visit your test sub → mod tools panel → 7 ModRadar menu items appear. Open
`ModRadar: settings` to set defaults, then `Open ModRadar Dashboard` to create
the live custom-post dashboard.

### Configure secrets

```bash
# Required for Module 4 (Agent Layer). Without it, agent silently no-ops.
devvit settings set anthropicApiKey

# Optional for Module 1 (Safe Browsing branch). Without it, scoring is heuristic-only.
devvit settings set safeBrowsingApiKey
```

### Configure per-subreddit behaviour

Mod-set via the **ModRadar: settings** menu form:

| Field | Default | Range |
|---|---|---|
| `editWindowHours` | 24 | 1–720 |
| `minDomainRiskScore` | 0.5 | 0.0–1.0 |
| `autoRemoveThreshold` | 0 (disabled) | 0.0–1.0 |
| `clusterMinGroupSize` | 3 | 2–20 |
| `agentMode` | `borderline` | `off` / `borderline` / `always` |
| `editRadarEnabled` | true | bool |
| `collisionShieldEnabled` | true | bool |
| `clusterRadarEnabled` | true | bool |

The form rejects `autoRemoveThreshold > 0` when below `minDomainRiskScore`
(would auto-remove items that don't even raise an alert).

---

## Commands

```bash
npm run dev            # vite build --watch (use with devvit playtest)
npm run build          # vite build (production bundle)
npm run type-check     # tsc --noEmit, project references
npm run lint           # eslint src
npm test               # vitest run (41 assertions)
npm run deploy         # publish a new revision to Reddit
npm run launch         # submit for public app review
```

CI gate sequence:

```bash
npm run type-check && npm run lint && npm test && npm run build
```

---

## Project structure

```
modradarr/
├── devvit.json              # menu, forms, triggers, scheduler, permissions, secrets
├── src/
│   ├── index.ts             # Hono bootstrap (mounts /api + /internal)
│   ├── core/
│   │   ├── redis-schema.ts  # key conventions + typed helpers
│   │   ├── diff-engine.ts   # body hash, URL extract, diff, edit window
│   │   ├── url-scorer.ts    # heuristic + redirect + Safe Browsing
│   │   ├── edit-radar.ts    # Module 1
│   │   ├── collision-shield.ts  # Module 2
│   │   ├── clustering.ts    # Module 3 — 3 passes
│   │   ├── cluster-radar.ts # Module 3 orchestration
│   │   ├── agent.ts         # Module 4 entry points
│   │   ├── agent-models.ts  # ChatAnthropic factories
│   │   ├── agent-prompts.ts # system prompts + delimiter-wrapped builders
│   │   ├── agent-middleware.ts  # timing + budget
│   │   └── nuke.ts          # legacy mop-comments scaffold
│   ├── routes/
│   │   ├── triggers.ts      # 6 trigger handlers
│   │   ├── scheduler.ts     # clusterScan, collisionCleanup
│   │   ├── menu.ts          # 7 menu items
│   │   ├── forms.ts         # mop forms + ModRadar settings
│   │   └── api.ts           # dashboard data + review locks + me
│   └── client/
│       ├── index.html       # dashboard shell
│       ├── dashboard.ts     # data load, realtime, heartbeat, bulk-action
│       ├── components/
│       │   └── diff-viewer.ts
│       └── styles.css       # dark theme, pulsing badges, agent UI
├── tests/                   # 4 vitest suites, 41 assertions
│   ├── diff-engine.test.ts
│   ├── clustering.test.ts
│   ├── agent-prompts.test.ts
│   └── agent-schemas.test.ts
└── dist/                    # vite + tsc output (gitignored)
```

Server-side modules live under `src/core/` and `src/routes/` (not `src/server/`)
because the Devvit vite plugin actively forbids importing from `src/server/`
into client code.

---

## Testing

End-to-end manual test plan: [`../test.md`](../test.md). It covers:

1. Automated gates (`type-check`, `lint`, `vitest`, `build`)
2. Module 1 — 9 cases (happy path, edit window, trusted-domain skip, scoring,
   auto-remove, idempotency, pre-install snapshots, delete eviction)
3. Module 2 — 6 cases (acquire/collide, realtime, heartbeat, cleanup, gate)
4. Module 3 — 10 cases (3 cluster types, bulk action, cron, perf, gate)
5. Module 4 — 13 cases (no-key, modes, cache, nudges, narration, budget,
   timeout, Zod, prompt-injection probe)
6. Settings, dashboard, realtime, edge cases, failure modes
7. Policy/privacy spot-checks (PII, TTLs, deletion cascade)

```bash
npm test
# Test Files  4 passed (4)
#       Tests  41 passed (41)
```

---

## Policy & privacy

ModRadar is designed to stay inside Reddit's March 2026 ban-bot policy line
*by behaviour, not by accident*:

- **No PII at rest.** Snapshots store post/comment IDs, body hashes, URL
  lists, and the opaque `t2_*` author ID. Author *names* are fetched live for
  display and never persisted long-term.
- **No cross-subreddit user tracking.** All clustering is in-sub. Domain
  reputation is the only cross-cutting signal, and it's domain-derived (no
  user data attached).
- **Behavioural ban-evasion only.** Signals are derived from in-sub behaviour,
  not from a user's participation in other subreddits.
- **TTLs everywhere transient.** Snapshots 30 d, alerts 30 d, clusters 1 h,
  locks 5 min, caches 6 h–24 h. Domain reputation is the only persistent
  store and contains no user data.
- **Content deletion respected.** `onPostDelete` / `onCommentDelete` evict
  snapshot + editlog + alert keys for the affected thing.
- **Automated actions disclosed.** Auto-remove is opt-in per sub
  (`autoRemoveThreshold > 0`), runs under the app account, and lands in the
  modlog with the standard "spam" flag.
- **Agent privacy.** Anthropic receives only the truncated body (1200 chars),
  added URLs, account age, heuristic signal tags, and the heuristic score.
  No usernames. No subreddit names. No mod identities. Bodies cached so
  identical inputs are never sent twice.

---

## Outbound HTTP

Only the following domains are allow-listed in `devvit.json`:

```
safebrowsing.googleapis.com
api.anthropic.com
bit.ly, tinyurl.com, t.co, ow.ly, goo.gl, is.gd, buff.ly, cutt.ly,
shorturl.at, rebrand.ly, tiny.cc, lnkd.in, rb.gy, trib.al, s.id, youtu.be
```

Shortener domains are listed so the redirect-resolver can chase them. The
real destinations are deliberately **not** allow-listed — we capture the
final URL but score it heuristically without fetching it.

---

## Cost model

For a moderate sub (~5k posts + 50k comments / day):

| Path | Calls / day | Model | Daily cost |
|---|---|---|---|
| Edit adjudication (borderline only) | ~30 | Haiku 4.5 | ~$0.03 |
| Cluster narration (risk ≥ 0.4) | ~12 | Sonnet 4.6 | ~$0.14 |
| **Worst-case total** | | | **~$0.17** |

A 200/day per-sub budget counter hard-stops runaway scenarios. Set
`agentMode = off` to opt out entirely.

---

## Documentation

| File | Purpose |
|---|---|
| [`../plan.md`](../plan.md) | Full implementation plan, redis schema, API reference, verification flow |
| [`../agent-plan.md`](../agent-plan.md) | Module 4 design + LangChain v1 integration notes |
| [`../test.md`](../test.md) | End-to-end test plan with 50+ test cases |
| [`../todo.md`](../todo.md) | Remaining P0/P1/P2 follow-ups |
| [`../idea.md`](../idea.md) | Original concept + evidence + judge-axis pitch |

---

## What it doesn't do (yet)

Tracked in [`../todo.md`](../todo.md):

- **Reporter-correlation clustering pass** — needs `onPostReport` /
  `onCommentReport` ingestion + persistent reporter sets.
- **Mocking layer** for `url-scorer` + `cluster-radar` unit tests.
- **App icon**, listing copy, 60 s demo video, Devpost writeup.
- Pre-publish polish: bump `package.json` 0.0.0 → 1.0.0, clean up `nuke.ts`
  scaffold lint warnings.

---

## Attribution

Built for the **Reddit Mod Tools Hackathon** (Devpost,
[mod-tools-migration.devpost.com](https://mod-tools-migration.devpost.com/)).

Grounded in:

- **ACM CHI 2026** — *Understanding How Reddit Moderators Use the Modqueue*
  ([dl.acm.org/doi/full/10.1145/3772318.3791931](https://dl.acm.org/doi/full/10.1145/3772318.3791931))
- **r/ModSupport** — post-edit link injection thread
- **r/modnews** — March 2026 ban-bot policy update

LangChain prompts and integration patterns sourced via the `docs-langchain`
MCP server against the official LangChain v1 JS docs.

---

## License

See [`LICENSE`](./LICENSE).
