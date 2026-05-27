import { connectRealtime } from '@devvit/web/client';
import { fetchEditLog, renderDiffViewer } from './components/diff-viewer';

type StoredCluster = {
  id: string;
  reason: string;
  label: string;
  summary: string;
  riskScore: number;
  detectedAt: string;
  itemIds: string[];
};

type AgentVerdict = {
  verdict: 'spam' | 'legit' | 'unclear';
  confidence: number;
  reasons: string[];
  suggestedAction: 'remove' | 'flag' | 'ignore';
};

type Alert = {
  thingId: string;
  type: 'post' | 'comment';
  authorName: string;
  permalink: string;
  addedUrls: string[];
  riskScore: number;
  detectedAt: string;
  removed: boolean;
  heuristicScore?: number;
  agentVerdict?: AgentVerdict;
};

type ReviewLock = {
  thingId: string;
  reviewer: string;
  startedAt: string;
};

type DashboardChannels = {
  reviewing: string;
  alerts: string;
} | null;

type ClusterNarration = {
  clusterId: string;
  narrative: string;
  campaignType: string;
  recommendedAction: 'remove_all' | 'review_individually' | 'dismiss';
  riskAdjustment: number;
};

type DashboardData = {
  state: { lastScanAt: string | null; count: number };
  clusters: StoredCluster[];
  clusterNarrations?: ClusterNarration[];
  alerts: Alert[];
  locks: ReviewLock[];
  channels: DashboardChannels;
};

type ReviewingEvent =
  | { type: 'review-started'; thingId: string; reviewer: string; startedAt: string }
  | { type: 'review-extended'; thingId: string; reviewer: string; startedAt: string }
  | { type: 'review-ended'; thingId: string; reviewer: string };

type AlertEvent =
  | { type: 'cluster-scan'; clusters: number; scanned: number; at: string }
  | { type: 'bulk-action-complete'; clusterId: string; action: string; affected: number }
  | { type: 'edit-alert'; thingId: string; riskScore: number; detectedAt: string };

const stateEl = document.getElementById('state')!;
const clustersEl = document.getElementById('clusters')!;
const alertsEl = document.getElementById('alerts')!;
const locksEl = document.getElementById('locks')!;
const locksStatusEl = document.getElementById('locks-status')!;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
const toastEl = document.getElementById('toast')!;

let toastTimer: number | undefined;
const activeLocks = new Map<string, ReviewLock>();
let subscribedReviewing: string | null = null;
let subscribedAlerts: string | null = null;
let currentUsername: string | null = null;
const HEARTBEAT_INTERVAL_MS = 60_000;

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  requestAnimationFrame(() => toastEl.classList.add('show'));
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    window.setTimeout(() => toastEl.classList.add('hidden'), 220);
  }, 2400);
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function riskBucket(score: number): { className: string; label: string } {
  if (score >= 0.75) return { className: 'high', label: 'high' };
  if (score >= 0.5) return { className: 'med', label: 'med' };
  return { className: '', label: 'watch' };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

let lastNarrationsById = new Map<string, ClusterNarration>();

function renderClusters(clusters: StoredCluster[]): void {
  if (clusters.length === 0) {
    clustersEl.innerHTML =
      '<div class="empty">No clusters yet — run a scan or wait for the next 5 min tick.</div>';
    return;
  }
  clustersEl.innerHTML = '';
  for (const c of clusters) {
    const bucket = riskBucket(c.riskScore);
    const node = document.createElement('div');
    node.className = 'cluster';
    node.dataset.clusterId = c.id;
    const narration = lastNarrationsById.get(c.id);
    const narrativeBlock = narration
      ? `<div class="cluster-narrative">
           <span class="campaign-tag">${escapeHtml(narration.campaignType.replace(/_/g, ' '))}</span>
           ${escapeHtml(narration.narrative)}
           <div class="recommended">recommend: ${escapeHtml(narration.recommendedAction.replace(/_/g, ' '))}</div>
         </div>`
      : '';
    node.innerHTML = `
      <div class="risk-badge ${bucket.className}">
        <span class="num">${c.riskScore.toFixed(2)}</span>
        <span class="lbl">${bucket.label}</span>
      </div>
      <div class="cluster-body">
        <div class="cluster-title">
          <span class="tag">${escapeHtml(c.reason)}</span>
          <span>${escapeHtml(c.label)}</span>
          <span class="hint">· ${formatRelative(c.detectedAt)}</span>
        </div>
        <div class="cluster-summary">${escapeHtml(c.summary)}</div>
        ${narrativeBlock}
        <div class="cluster-items">
          ${c.itemIds
            .slice(0, 8)
            .map(
              (id) =>
                `<a href="https://www.reddit.com/${encodeURI(id)}" target="_blank" rel="noopener">${escapeHtml(id)}</a>`
            )
            .join('')}
          ${c.itemIds.length > 8 ? `<span class="hint">+${c.itemIds.length - 8} more</span>` : ''}
        </div>
        <div class="cluster-actions">
          <button class="btn danger" data-action="remove">Remove all</button>
          <button class="btn" data-action="ignore">Dismiss</button>
        </div>
      </div>
    `;
    clustersEl.appendChild(node);
  }
}

function renderAlerts(alerts: Alert[]): void {
  if (alerts.length === 0) {
    alertsEl.innerHTML = '<div class="empty">No edit alerts yet.</div>';
    return;
  }
  alertsEl.innerHTML = '';
  for (const a of alerts) {
    const scoreClass = a.riskScore >= 0.75 ? 'high' : '';
    const link = a.permalink
      ? `https://www.reddit.com${a.permalink}`
      : `https://www.reddit.com/${encodeURI(a.thingId)}`;
    const node = document.createElement('div');
    node.className = 'alert';
    node.dataset.thingId = a.thingId;
    const verdictBadge = a.agentVerdict
      ? `<span class="agent-badge ${a.agentVerdict.verdict}" title="agent confidence ${a.agentVerdict.confidence.toFixed(2)}">${a.agentVerdict.verdict}</span>`
      : '';
    const verdictReasons = a.agentVerdict && a.agentVerdict.reasons.length > 0
      ? `<div class="agent-reasons">${a.agentVerdict.reasons.map((r) => `<span>${escapeHtml(r)}</span>`).join('')}</div>`
      : '';
    node.innerHTML = `
      <div class="alert-row">
        <div class="score ${scoreClass}">${a.riskScore.toFixed(2)}</div>
        <div class="alert-meta">
          <a href="${link}" target="_blank" rel="noopener">${escapeHtml(a.thingId)}</a>
          <span class="who">u/${escapeHtml(a.authorName)} · ${a.addedUrls.length} url${a.addedUrls.length === 1 ? '' : 's'} added · ${formatRelative(a.detectedAt)}</span>
        </div>
        ${verdictBadge}
        ${a.removed ? '<span class="flag">removed</span>' : ''}
        <button class="btn diff-toggle" data-action="toggle-diff" aria-expanded="false">View diff</button>
      </div>
      ${verdictReasons}
      <div class="alert-diff hidden" aria-hidden="true"></div>
    `;
    alertsEl.appendChild(node);
  }
}

async function toggleDiff(alertNode: HTMLElement, button: HTMLButtonElement): Promise<void> {
  const thingId = alertNode.dataset.thingId;
  if (!thingId) return;
  const panel = alertNode.querySelector('.alert-diff') as HTMLElement | null;
  if (!panel) return;
  const open = !panel.classList.contains('hidden');
  if (open) {
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    button.textContent = 'View diff';
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!panel.dataset.loaded) {
    panel.innerHTML = '<div class="hint">Loading diff…</div>';
    try {
      const event = await fetchEditLog(thingId);
      if (!event) {
        panel.innerHTML = '<div class="empty">No edit history stored for this item.</div>';
      } else {
        panel.innerHTML = renderDiffViewer(event);
      }
      panel.dataset.loaded = '1';
    } catch (err) {
      console.error('diff load failed', err);
      panel.innerHTML = `<div class="empty">Failed to load diff: ${escapeHtml((err as Error).message)}</div>`;
    }
  }
  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
  button.textContent = 'Hide diff';
  button.setAttribute('aria-expanded', 'true');
}

function renderState(state: DashboardData['state']): void {
  stateEl.textContent = `last scan ${formatRelative(state.lastScanAt)} · ${state.count} cluster${state.count === 1 ? '' : 's'}`;
}

function renderLocks(): void {
  if (activeLocks.size === 0) {
    locksEl.innerHTML = '<div class="empty">No active locks.</div>';
    return;
  }
  const sorted = [...activeLocks.values()].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
  );
  locksEl.innerHTML = '';
  for (const lock of sorted) {
    const link = `https://www.reddit.com/${encodeURI(lock.thingId)}`;
    const node = document.createElement('div');
    node.className = 'lock';
    node.dataset.thingId = lock.thingId;
    node.innerHTML = `
      <span class="pulse" aria-hidden="true"></span>
      <div class="lock-meta">
        <a href="${link}" target="_blank" rel="noopener">${escapeHtml(lock.thingId)}</a>
        <span class="who">u/${escapeHtml(lock.reviewer)} · started ${formatRelative(lock.startedAt)}</span>
      </div>
    `;
    locksEl.appendChild(node);
  }
}

function setLocksStatus(text: string, live: boolean): void {
  locksStatusEl.textContent = text;
  locksStatusEl.classList.toggle('live', live);
  locksStatusEl.classList.toggle('offline', !live);
}

function applyReviewingEvent(event: ReviewingEvent): void {
  if (event.type === 'review-started' || event.type === 'review-extended') {
    activeLocks.set(event.thingId, {
      thingId: event.thingId,
      reviewer: event.reviewer,
      startedAt: event.startedAt,
    });
  } else if (event.type === 'review-ended') {
    activeLocks.delete(event.thingId);
  }
  renderLocks();
}

async function ensureSubscriptions(channels: DashboardChannels): Promise<void> {
  if (!channels) {
    setLocksStatus('offline · no channel info', false);
    return;
  }
  if (subscribedReviewing !== channels.reviewing) {
    subscribedReviewing = channels.reviewing;
    try {
      await connectRealtime({
        channel: channels.reviewing,
        onConnect: () => setLocksStatus('live', true),
        onDisconnect: () => setLocksStatus('reconnecting…', false),
        onMessage: (data) => applyReviewingEvent(data as ReviewingEvent),
      });
    } catch (err) {
      console.error('reviewing realtime connect failed', err);
      setLocksStatus('offline · realtime failed', false);
    }
  }
  if (subscribedAlerts !== channels.alerts) {
    subscribedAlerts = channels.alerts;
    try {
      await connectRealtime({
        channel: channels.alerts,
        onMessage: (data) => {
          const event = data as AlertEvent;
          if (event.type === 'cluster-scan') {
            showToast(`Auto-refresh · ${event.clusters} cluster${event.clusters === 1 ? '' : 's'}`);
            void loadDashboard();
          } else if (event.type === 'bulk-action-complete') {
            void loadDashboard();
          } else if (event.type === 'edit-alert') {
            showToast(`New edit alert · risk ${event.riskScore.toFixed(2)}`);
            void loadDashboard();
          }
        },
      });
    } catch (err) {
      console.error('alerts realtime connect failed', err);
    }
  }
}

async function loadDashboard(): Promise<void> {
  refreshBtn.disabled = true;
  try {
    const res = await fetch('/api/dashboard-data');
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = (await res.json()) as DashboardData;
    lastNarrationsById = new Map(
      (data.clusterNarrations ?? []).map((n) => [n.clusterId, n])
    );
    renderState(data.state);
    renderClusters(data.clusters);
    renderAlerts(data.alerts);
    activeLocks.clear();
    for (const lock of data.locks) {
      activeLocks.set(lock.thingId, lock);
    }
    renderLocks();
    void ensureSubscriptions(data.channels);
  } catch (err) {
    console.error(err);
    showToast(`Failed to load dashboard: ${(err as Error).message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

async function triggerScan(): Promise<void> {
  scanBtn.disabled = true;
  const original = scanBtn.textContent;
  scanBtn.textContent = 'Scanning…';
  try {
    const res = await fetch('/api/cluster-scan-now', { method: 'POST' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = (await res.json()) as { scanned: number; clusters: number };
    showToast(`Scanned ${data.scanned} items · ${data.clusters} clusters`);
    await loadDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Scan failed: ${(err as Error).message}`);
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = original;
  }
}

async function clusterAction(
  clusterId: string,
  action: 'remove' | 'ignore',
  itemCount: number
): Promise<void> {
  if (action === 'remove') {
    const ok = window.confirm(
      `Remove all ${itemCount} item(s) in this cluster? This cannot be undone from the dashboard.`
    );
    if (!ok) return;
  }
  try {
    const res = await fetch('/api/bulk-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clusterId, action }),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const result = (await res.json()) as {
      affected: number;
      failures: number;
      action: string;
    };
    if (action === 'remove') {
      showToast(
        `Removed ${result.affected} item(s)${result.failures > 0 ? ` · ${result.failures} failed` : ''}`
      );
    } else {
      showToast('Cluster dismissed');
    }
    await loadDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Action failed: ${(err as Error).message}`);
  }
}

async function fetchCurrentUser(): Promise<void> {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return;
    const data = (await res.json()) as { username: string | null };
    currentUsername = data.username;
  } catch (err) {
    console.error('fetchCurrentUser failed', err);
  }
}

async function heartbeatOwnedLocks(): Promise<void> {
  if (!currentUsername) return;
  for (const lock of activeLocks.values()) {
    if (lock.reviewer !== currentUsername) continue;
    try {
      await fetch('/api/review-heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thingId: lock.thingId }),
      });
    } catch (err) {
      console.error('heartbeat failed', lock.thingId, err);
    }
  }
}

alertsEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest('button[data-action="toggle-diff"]') as HTMLButtonElement | null;
  if (!button) return;
  const alertNode = button.closest('.alert') as HTMLElement | null;
  if (!alertNode) return;
  void toggleDiff(alertNode, button);
});

clustersEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.tagName !== 'BUTTON') return;
  const action = target.dataset.action;
  if (action !== 'remove' && action !== 'ignore') return;
  const card = target.closest('.cluster') as HTMLElement | null;
  const clusterId = card?.dataset.clusterId;
  if (!clusterId) return;
  const itemCount = card?.querySelectorAll('.cluster-items a').length ?? 0;
  void clusterAction(clusterId, action, itemCount);
});

refreshBtn.addEventListener('click', () => void loadDashboard());
scanBtn.addEventListener('click', () => void triggerScan());

void fetchCurrentUser();
void loadDashboard();
window.setInterval(() => void loadDashboard(), 60_000);
window.setInterval(() => void heartbeatOwnedLocks(), HEARTBEAT_INTERVAL_MS);

window.addEventListener('beforeunload', () => {
  if (!currentUsername) return;
  for (const lock of activeLocks.values()) {
    if (lock.reviewer !== currentUsername) continue;
    navigator.sendBeacon?.(
      '/api/review-release',
      new Blob([JSON.stringify({ thingId: lock.thingId })], { type: 'application/json' })
    );
  }
});
