export type EditEvent = {
  timestamp: string;
  addedUrls: string[];
  removedUrls: string[];
  diffPreview: string;
};

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

function splitBeforeAfter(preview: string): { before: string; after: string } {
  const beforeIdx = preview.indexOf('BEFORE:');
  const afterIdx = preview.indexOf('AFTER:');
  if (beforeIdx === -1 || afterIdx === -1 || afterIdx < beforeIdx) {
    return { before: preview, after: '' };
  }
  const before = preview.slice(beforeIdx + 'BEFORE:'.length, afterIdx).trim();
  const after = preview.slice(afterIdx + 'AFTER:'.length).trim();
  return { before, after };
}

function renderUrlList(urls: string[], kind: 'added' | 'removed'): string {
  if (urls.length === 0) return '';
  const items = urls
    .map(
      (u) =>
        `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a></li>`
    )
    .join('');
  const label = kind === 'added' ? 'URLs added' : 'URLs removed';
  return `<div class="diff-urls ${kind}"><div class="diff-urls-label">${label} (${urls.length})</div><ul>${items}</ul></div>`;
}

export function renderDiffViewer(event: EditEvent): string {
  const { before, after } = splitBeforeAfter(event.diffPreview);
  const added = renderUrlList(event.addedUrls, 'added');
  const removed = renderUrlList(event.removedUrls, 'removed');
  return `
    <div class="diff-viewer" role="region" aria-label="Edit diff">
      <div class="diff-pane diff-before">
        <div class="diff-label">Before</div>
        <pre>${escapeHtml(before)}</pre>
      </div>
      <div class="diff-pane diff-after">
        <div class="diff-label">After</div>
        <pre>${escapeHtml(after)}</pre>
      </div>
      <div class="diff-urls-wrap">${added}${removed}</div>
    </div>
  `;
}

export async function fetchEditLog(thingId: string): Promise<EditEvent | null> {
  const res = await fetch(`/api/edit-log?thingId=${encodeURIComponent(thingId)}`);
  if (!res.ok) throw new Error(`edit-log http ${res.status}`);
  const data = (await res.json()) as { event: EditEvent | null };
  return data.event;
}
