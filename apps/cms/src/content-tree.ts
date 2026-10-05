export type ContentTreePage = {
  id: string
  title: string
  template: string
  slug?: string
  status?: string | null
  updatedAt?: string | null
  _status?: string | null
  parentId?: string | { id?: string } | null
  sectionId?: string | { id?: string } | null
}

export type ContentTreeSection = { id: string; name: string; slug?: string; landingPageId?: string | { id?: string } | null }
export type ContentTreeNode = { page: ContentTreePage; children: ContentTreeNode[]; cycle: boolean }
export type ContentTreeGroup = { section: ContentTreeSection; roots: ContentTreeNode[]; unplaced: ContentTreeNode[] }
export type ContentTree = { sections: ContentTreeGroup[]; unassigned: ContentTreeNode[] }

export const idOf = (value: ContentTreePage['parentId'] | ContentTreePage['sectionId']) => typeof value === 'string' ? value : value?.id

function sorted<T extends ContentTreePage>(pages: T[]): T[] {
  return [...pages].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
}

function nodesFor(pages: ContentTreePage[]): { roots: ContentTreeNode[]; unplaced: ContentTreeNode[] } {
  const byID = new Map(pages.map((page) => [page.id, page]))
  const children = new Map<string, ContentTreePage[]>()
  const roots: ContentTreePage[] = []
  for (const page of pages) {
    const parent = idOf(page.parentId)
    if (!parent || !byID.has(parent)) roots.push(page)
    else children.set(parent, [...(children.get(parent) ?? []), page])
  }
  const emitted = new Set<string>()
  const node = (page: ContentTreePage, lineage = new Set<string>()): ContentTreeNode => {
    const cycle = lineage.has(page.id)
    if (cycle) return { page, children: [], cycle: true }
    emitted.add(page.id)
    const next = new Set(lineage).add(page.id)
    return { page, cycle: false, children: sorted(children.get(page.id) ?? []).map((child) => node(child, next)) }
  }
  const rootNodes = sorted(roots).map((page) => node(page))
  // A cycle has no root. Keep every malformed component visible instead of
  // silently omitting it from the editor's view.
  const unplaced: ContentTreeNode[] = []
  for (const page of sorted(pages)) if (!emitted.has(page.id)) unplaced.push(node(page))
  return { roots: rootNodes, unplaced }
}

/** Builds a complete, deterministic view even when persisted parent or section
 * relationships are malformed. Validation prevents new bad trees; this keeps
 * existing imported data repairable. */
export function buildContentTree(sections: ContentTreeSection[], pages: ContentTreePage[]): ContentTree {
  const sectionIDs = new Set(sections.map((section) => section.id))
  const groups = sections.map((section) => ({ section, ...nodesFor(pages.filter((page) => idOf(page.sectionId) === section.id)) }))
  const unassignedGroup = nodesFor(pages.filter((page) => !sectionIDs.has(idOf(page.sectionId) ?? '')))
  return { sections: groups, unassigned: [...unassignedGroup.roots, ...unassignedGroup.unplaced] }
}

/** Matches the public route semantics while keeping drafts and malformed imported
 * pages visible in staff tooling. Undefined means this working copy has no
 * canonical route until its section or ancestry is repaired. */
export function canonicalContentPath(page: ContentTreePage, pages: ContentTreePage[], sections: ContentTreeSection[], homepageID?: string): string | undefined {
  const validSlug = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  const validSectionSlug = (value: unknown): value is string => value === '' || validSlug(value)
  const pageSectionID = idOf(page.sectionId)
  const section = sections.find((item) => item.id === pageSectionID)
  if (!section || !validSectionSlug(section.slug) || !validSlug(page.slug)) return undefined
  const landingID = idOf(section.landingPageId)
  const parentID = idOf(page.parentId)
  if (homepageID && page.id === homepageID) return parentID ? undefined : '/'
  if (landingID && page.id === landingID) return parentID ? undefined : section.slug ? `/${section.slug}` : '/'
  const byID = new Map(pages.map((item) => [item.id, item]))
  const ancestors: ContentTreePage[] = []
  const seen = new Set<string>([page.id])
  let currentParentID = parentID
  while (currentParentID) {
    if (seen.has(currentParentID)) return undefined
    const parent = byID.get(currentParentID)
    if (!parent || idOf(parent.sectionId) !== pageSectionID || !validSlug(parent.slug)) return undefined
    seen.add(currentParentID)
    ancestors.unshift(parent)
    currentParentID = idOf(parent.parentId)
  }
  return `/${[section.slug, ...ancestors.filter((item) => item.id !== landingID).map((item) => item.slug), page.slug].filter(Boolean).join('/')}`
}
