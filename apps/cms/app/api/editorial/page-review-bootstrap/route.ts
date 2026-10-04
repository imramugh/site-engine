const script = String.raw`(() => {
  const source = document.currentScript;
  const expected = source && source.dataset.pageReviewSet;
  if (!expected || !/^[0-9a-f-]{36}$/i.test(expected) || document.querySelector('[data-public-page-review]')) return;
  fetch('/api/editorial/page-review-entry?path=' + encodeURIComponent(location.pathname), { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then(({ entries }) => {
      const available = Array.isArray(entries) ? entries.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string') : [];
      let entry = available.find((item) => item.id === expected);
      if (!entry) return;
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/api/editorial/page-review-overlay.css'; document.head.append(stylesheet);
      const bar = document.createElement('aside'); bar.dataset.publicPageReview = 'true'; bar.setAttribute('aria-label', 'Pending page review');
      const text = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = available.length === 1 ? 'This page has a pending change' : available.length + ' pending changes on this page';
      const detail = document.createElement('small'); detail.textContent = entry.name + ' · revision ' + entry.revision; text.append(strong, detail);
      let selector;
      if (available.length > 1) {
        const label = document.createElement('label'); label.textContent = 'Choose change set'; selector = document.createElement('select'); selector.setAttribute('aria-label', 'Choose change set');
        available.forEach((item) => { const option = document.createElement('option'); option.value = item.id + ':' + (item.pageID || ''); option.textContent = item.name + ' · revision ' + item.revision; option.selected = item.id === entry.id && item.pageID === entry.pageID; selector.append(option); });
        label.append(selector); selector.addEventListener('change', () => { const selected = available[selector.selectedIndex]; if (!selected) return; entry = selected; detail.textContent = entry.name + ' · revision ' + entry.revision; });
        text.append(label);
      }
      const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Review on page';
      const dialog = document.createElement('dialog'); dialog.dataset.publicPageReviewDialog = 'true'; dialog.setAttribute('aria-label', 'Page review workspace');
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close review'; close.dataset.publicPageReviewClose = 'true';
      const frame = document.createElement('iframe'); frame.title = 'Page review workspace';
      dialog.append(close, frame); open.addEventListener('click', () => { frame.src = '/review/' + encodeURIComponent(entry.id) + (entry.pageID ? '?pageID=' + encodeURIComponent(entry.pageID) : ''); dialog.showModal(); }); close.addEventListener('click', () => dialog.close());
      bar.append(text, open); document.body.append(bar, dialog);
    }).catch(() => {});
})();`

export async function GET(): Promise<Response> {
  return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } })
}
