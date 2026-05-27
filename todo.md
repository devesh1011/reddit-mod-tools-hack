# ModRadar — TODO

Status snapshot as of 2026-05-26. Build is green: type-check ✓, lint ✓, vite build ✓.
All three modules ship functional MVP code paths; items below are gaps vs the original plan
or production-readiness polish.

Legend: **P0** = ship-blockers / demo regressions, **P1** = visible polish, **P2** = nice-to-have.

---

## Module 1 — Edit Radar

- [ ] **P1 — Safe Browsing API integration.** Plan called for `safebrowsing.googleapis.com` HTTP
      fetch with weight 0.3 in the composite score. Currently scorer uses heuristic-only
      (shortener list + suspicious TLDs + prior-report counter). Needs:
      - re-add `permissions.http.domains: ["safebrowsing.googleapis.com"]` to `devvit.json`
      - `url-scorer.ts` async fetch with timeout + cache hits in Redis (24h TTL)
      - graceful fallback when domain not allow-listed yet (current behavior)
- [ ] **P1 — Redirect resolution for shortened URLs.** Plan called for resolving redirects
      via `fetch()` (max 3 redirects, 30s timeout) to see the real destination domain. Today
      we score on the shortener domain itself, not the target. Needs HTTP permission +
      cautious follow-redirect implementation.
- [ ] **P2 — Domain-age heuristic.** Plan listed 0.3 weight for "newly registered" domains.
      No WHOIS access in Devvit; current proxy heuristic is short SLD length + uncommon TLD.
      Could extend with a small bundled "young domain" blocklist refreshed periodically.
- [ ] **P2 — Edit log preview rendering.** `appendEditLog` stores `diffPreview` strings but
      the dashboard never displays them. Wire into alert detail view.
- [ ] **P2 — Skip self-actions.** Plan flagged "trigger for own app's actions (skip self)"
      as an edge case. Today our `reddit.remove()` does not refire as an `onPostUpdate`, but
      a defensive `if (authorId === appAccount.id) return` guard would future-proof against
      submitting comments via the app account later.

---

## Module 2 — Collision Shield

- [ ] **P0 — Realtime ambient badges.** The whole pitch of Collision Shield is "see the
      badge before you click." Today the collision is only visible *after* you click the
      menu. To deliver the planned UX we need:
      - `permissions.realtime: true` in `devvit.json`
      - `realtime.send("modradar-{subredditId}-reviewing", { ... })` on acquire/release
      - dashboard client subscribes via `connectRealtime()` and renders live badges next
        to cluster items
      - heartbeat from dashboard webview while it has focus
- [ ] **P1 — Client heartbeat extension.** `/api/review-heartbeat` endpoint exists but
      nothing calls it client-side yet. Once the dashboard shows live locks, it should poll
      heartbeat every 60s while the user has an item "active" in the UI so locks survive
      longer reviews than 5 min.
- [ ] **P2 — Per-mod active-locks panel.** Easy add to dashboard: show "your active locks"
      with one-click release.

---

## Module 3 — Cluster Radar

- [ ] **P0 — Dashboard post reuse instead of new-per-click.**
      Today every "Open ModRadar Dashboard" menu click creates a fresh custom post. Should:
      - track latest dashboard `postId` in Redis (`mr:{sub}:dashboard:postId`)
      - if exists and post still alive, return `navigateTo` instead of `submitCustomPost`
      - use `post.mergePostData()` to bump a refresh signal so any open client refetches
- [ ] **P1 — Cluster scan batching for large subs.** `runClusterScan` currently takes the
      last 250 recent items as one in-memory slice. Plan called for batches of 50 with a
      cursor stored in Redis, resumed next scheduler tick. Needed when this runs on subs
      with thousands of items/day to stay under the 30s request budget.
- [ ] **P1 — Realtime push for new clusters.** Dashboard polls `/api/dashboard-data` every
      60s. Wire a `modradar-{subredditId}-alerts` channel: `realtime.send` after every
      successful scan, dashboard refetches on message. Sub-second updates, drops poll noise.
- [ ] **P1 — Reporter-correlation clustering pass.** Plan included a Pass D (group items
      with overlapping reporter sets to detect brigaded reporting). Skipped in MVP because
      trigger payload doesn't carry reporter IDs and a fetch per item would blow the 30s
      budget. Needs investigation: maybe pull reports from `onPostReport`/`onCommentReport`
      triggers and store reporter sets in Redis.
- [ ] **P2 — Per-cluster drill-down.** Dashboard shows first 8 item IDs as links.
      "+N more" is a count, not expandable. Add expand toggle.
- [ ] **P2 — Snooze / mute domains.** Dismissed clusters come back next scan. Add
      "Dismiss + snooze this domain 24h" action.

---

## Settings & Configuration

- [ ] **P1 — Settings form UI.** Plan included a settings form covering `editWindowHours`,
      `minDomainRiskScore`, `autoRemoveThreshold`, `clusterMinGroupSize`, plus per-module
      toggles and notification level. Currently the defaults are written on install and
      there's no UI to change them. Needs:
      - `forms.settingsForm` declaration in `devvit.json`
      - "ModRadar Settings" subreddit menu item
      - `showSettingsForm` handler returning `showForm` UiResponse with all fields
      - submit handler that `HSET`s `mr:{sub}:settings`
      - dashboard "Settings" button that opens the same form via `navigateTo`
- [ ] **P2 — Per-module enable toggles wired.** Settings type already has the booleans,
      but only `editRadarEnabled` is checked. Wire `collisionShieldEnabled` /
      `clusterRadarEnabled` into their handlers.

---

## Tests

- [ ] **P1 — Vitest suites for pure-logic modules.** Devvit is hard to integration-test
      but the deterministic core is unit-testable. Add:
      - `tests/diff-engine.test.ts` — URL extraction edge cases, hash determinism, diff
        of added/removed sets, edit-window arithmetic
      - `tests/url-scorer.test.ts` — shortener detection, TLD scoring, trusted-domain skip,
        score bounds `[0, 1]`
      - `tests/clustering.test.ts` — minGroupSize enforcement, time-window grouping,
        deduplication fingerprint, risk-score monotonicity
- [ ] **P2 — Manual playtest checklist.** Verification plan in `plan.md` is a good start;
      convert to a markdown checklist in `tests/playtest.md` for repeatable demo runs.

---

## Polish / Submission

- [ ] **P1 — App icon.** `public/icon.png` (1024×1024) referenced in plan but not present.
      Once added, declare in `marketingAssets.icon`.
- [ ] **P1 — App listing copy.** `displayName` + `description` belong on the
      developers.reddit.com app page (not in `devvit.json`). Draft copy + screenshots.
- [ ] **P1 — 60s demo video.** Devpost submission requirement. Storyboard:
      1. Mod installs ModRadar.
      2. Spam edit → modqueue alert appears within seconds.
      3. Two mods click same modqueue item → collision toast.
      4. 3 coordinated posts → cluster card appears → one-click "Remove all".
- [ ] **P1 — Devpost writeup.** Pull pitch lines from `idea.md`. Cover: problem, solution,
      tech stack, impact, what's next.
- [ ] **P2 — Logging cleanup.** Production-ready logs should be structured JSON, not
      `console.log` strings. Devvit captures stdout for the logs CLI, so structured is fine.

---

## Documentation

- [ ] **P2 — README.md for the repo.** The scaffold README is generic. Replace with
      ModRadar-specific install + dev instructions.
- [ ] **P2 — Architecture diagram in plan.md.** Update the ASCII diagram in `plan.md` to
      reflect actual implemented module structure (`src/core/*` instead of `src/server/*`).

---

## Known scaffold gotchas (not bugs, just notes for future-me)

- App slug is `modradarr` (double-r) due to scaffold typo. If renaming, requires re-creating
  the app on developers.reddit.com — `name` in `devvit.json` is the immutable app-account
  slug. Live with it for hackathon, fix on first publish to public.
- `package.json` is at version 0.0.0; bump to 1.0.0 before `devvit publish`.
- Pre-existing scaffold lint errors in `src/core/nuke.ts` (`no-useless-assignment` x2).
  Not ours but will block `npm run deploy` if its lint gate enforces. Cheap fix: change
  `let success = true` to `let success: boolean` in both handlers.
