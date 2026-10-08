const selector = '[data-page-listing]'

function parameter(root: HTMLElement, suffix: string) {
  return `${root.dataset.pageListingId ?? 'listing'}-${suffix}`
}

function positivePage(value: string | null) {
  const page = Number(value ?? '1')
  return Number.isFinite(page) ? Math.max(1, Math.floor(page) || 1) : 1
}

export function mountPageListings(document: Document, window: Window) {
  document.querySelectorAll<HTMLElement>(selector).forEach((root) => {
    if (root.dataset.pageListingBound === 'true') return
    root.dataset.pageListingBound = 'true'
    const query = root.querySelector<HTMLInputElement>('[data-page-listing-query]')
    const count = root.querySelector<HTMLElement>('[data-page-listing-count]')
    const reset = root.querySelector<HTMLButtonElement>('[data-page-listing-reset]')
    const empty = root.querySelector<HTMLElement>('[data-page-listing-empty]')
    const pagination = root.querySelector<HTMLElement>('[data-page-listing-pagination]')
    const controls = root.querySelector<HTMLElement>('[data-page-listing-controls]')
    const items = [...root.querySelectorAll<HTMLElement>('[data-page-listing-item]')]
    if (!query || !count || !reset || !empty || !pagination || !controls) return

    controls.hidden = false
    const pageSize = Math.max(1, Number(root.dataset.pageListingPageSize ?? '6'))
    const searchKey = parameter(root, 'q')
    const pageKey = parameter(root, 'page')
    const initial = new URL(window.location.href)
    query.value = initial.searchParams.get(searchKey) ?? ''
    let page = positivePage(initial.searchParams.get(pageKey))

    const syncURL = (term: string) => {
      const url = new URL(window.location.href)
      if (term) url.searchParams.set(searchKey, term); else url.searchParams.delete(searchKey)
      if (page > 1) url.searchParams.set(pageKey, String(page)); else url.searchParams.delete(pageKey)
      window.history.replaceState(window.history.state, '', url)
    }
    const render = () => {
      const term = query.value.trim().toLocaleLowerCase()
      const matches = items.filter((item) => (item.dataset.pageListingSearch ?? '').toLocaleLowerCase().includes(term))
      const pages = Math.max(1, Math.ceil(matches.length / pageSize))
      page = Math.min(page, pages)
      const start = (page - 1) * pageSize
      const visible = new Set(matches.slice(start, start + pageSize))
      items.forEach((item) => { item.hidden = !visible.has(item) })
      count.textContent = matches.length === 1 ? '1 result' : `${matches.length} results`
      empty.hidden = matches.length !== 0
      reset.hidden = !term
      pagination.replaceChildren()
      pagination.hidden = matches.length <= pageSize
      if (!pagination.hidden) {
        const previous = document.createElement('button')
        previous.type = 'button'
        previous.textContent = 'Previous'
        previous.disabled = page === 1
        previous.dataset.pageListingPage = String(page - 1)
        pagination.append(previous)
        for (let index = 1; index <= pages; index += 1) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = String(index)
          button.disabled = index === page
          button.setAttribute('aria-label', `Page ${index}`)
          if (index === page) button.setAttribute('aria-current', 'page')
          button.dataset.pageListingPage = String(index)
          pagination.append(button)
        }
        const next = document.createElement('button')
        next.type = 'button'
        next.textContent = 'Next'
        next.disabled = page === pages
        next.dataset.pageListingPage = String(page + 1)
        pagination.append(next)
      }
      syncURL(term)
    }
    const restoreFromURL = () => {
      const url = new URL(window.location.href)
      query.value = url.searchParams.get(searchKey) ?? ''
      page = positivePage(url.searchParams.get(pageKey))
      render()
    }
    window.addEventListener('popstate', restoreFromURL)
    query.addEventListener('input', () => { page = 1; render() })
    reset.addEventListener('click', () => { query.value = ''; page = 1; query.focus(); render() })
    pagination.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-page-listing-page]')
      if (!button || button.disabled) return
      page = Number(button.dataset.pageListingPage)
      render()
      root.querySelector<HTMLElement>('[data-page-listing-results]')?.focus()
    })
    render()
  })
}
