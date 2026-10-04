const script = String.raw`(() => {
  const source = document.currentScript;
  const expected = source && source.dataset.pageReviewSet;
  if (!expected || !/^[0-9a-f-]{36}$/i.test(expected) || document.querySelector('[data-public-page-review]')) return;
  fetch('/api/editorial/page-review-entry?path=' + encodeURIComponent(location.pathname), { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then(({ entries }) => {
      const entry = Array.isArray(entries) && entries.find((item) => item && item.id === expected);
      if (!entry) return;
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/api/editorial/page-review-overlay.css'; document.head.append(stylesheet);
      const bar = document.createElement('aside'); bar.dataset.publicPageReview = 'true'; bar.setAttribute('aria-label', 'Pending page review');
      const text = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = entries.length === 1 ? 'This page has a pending change' : entries.length + ' pending changes on this page';
      const detail = document.createElement('small'); detail.textContent = entry.name + ' · revision ' + entry.revision; text.append(strong, detail);
      const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Review on page';
      const dialog = document.createElement('dialog'); dialog.dataset.publicPageReviewDialog = 'true'; dialog.setAttribute('aria-label', 'Page review workspace');
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close review'; close.dataset.publicPageReviewClose = 'true';
      const frame = document.createElement('iframe'); frame.title = 'Page review workspace'; frame.src = '/review/' + encodeURIComponent(entry.id);
      dialog.append(close, frame); open.addEventListener('click', () => dialog.showModal()); close.addEventListener('click', () => dialog.close());
      bar.append(text, open); document.body.append(bar, dialog);
    }).catch(() => {});
})();`

export async function GET(): Promise<Response> {
  return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } })
}
