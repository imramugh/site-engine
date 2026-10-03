import { TemplateAllowedBlocks, type Block, type Page, type Section } from '@site-engine/contract'

type Template = Page['template']

export type TreePage = Pick<Page, 'id' | 'sectionId' | 'parentId' | 'slug' | 'template' | 'blocks'> & { title?: string }
export type TreeSection = Pick<Section, 'id' | 'allowedTemplates'>

export type FieldIssue = { field: string; message: string }

function parentIssue(page: TreePage, parent: TreePage | undefined): FieldIssue | undefined {
  if (page.template === 'service' && (!parent || parent.template !== 'pillar')) {
    return { field: 'parentId', message: 'service pages require a pillar parent in the same section.' }
  }
}

/** Validate a candidate page together with its persisted siblings and descendants. */
export function validatePageTree(candidate: TreePage, pages: readonly TreePage[], section: TreeSection | undefined): FieldIssue[] {
  const issues: FieldIssue[] = []
  if (!section) return [{ field: 'sectionId', message: 'Select an existing content section.' }]
  if (!section.allowedTemplates.includes(candidate.template)) {
    issues.push({ field: 'template', message: `${candidate.template} is not allowed in the selected section. Choose one of: ${section.allowedTemplates.join(', ')}.` })
  }

  const allPages = new Map(pages.map((page) => [page.id, page]))
  allPages.set(candidate.id, candidate)
  const sibling = [...allPages.values()].find((page) => page.id !== candidate.id && page.sectionId === candidate.sectionId && page.parentId === candidate.parentId && page.slug === candidate.slug)
  if (sibling) issues.push({ field: 'slug', message: 'A page with this URL segment already exists under the selected parent.' })

  // A normal page update is a single-document operation. Moving a parent to a
  // different section would leave its existing children in the old section.
  // A future structure operation can move the whole subtree atomically.
  if ([...allPages.values()].some((page) => page.parentId === candidate.id && page.sectionId !== candidate.sectionId)) {
    issues.push({ field: 'sectionId', message: 'Move child pages to compatible parents before moving this page to another section.' })
  }

  // A move can make an existing descendant too deep or invalidate a child's
  // required parent template, so validate every affected member of this tree.
  for (const page of allPages.values()) {
    if (page.sectionId !== candidate.sectionId && page.id !== candidate.id) continue
    const parent = page.parentId ? allPages.get(page.parentId) : undefined
    if (page.parentId && !parent) {
      if (page.id === candidate.id) issues.push({ field: 'parentId', message: 'Select an existing parent page.' })
      continue
    }
    if (parent && parent.sectionId !== page.sectionId) {
      if (page.id === candidate.id) issues.push({ field: 'parentId', message: 'Parent pages must belong to the same section.' })
      continue
    }
    const relationship = parentIssue(page, parent)
    if (relationship && page.id === candidate.id) issues.push(relationship)
    if (relationship && parent?.id === candidate.id) issues.push({ field: 'template', message: `This template cannot be used while child page ${page.slug} requires a pillar parent.` })

    const visited = new Set<string>([page.id])
    let current = page
    let depth = 1
    while (current.parentId) {
      if (visited.has(current.parentId)) {
        if (page.id === candidate.id || current.parentId === candidate.id) issues.push({ field: 'parentId', message: 'A page cannot be moved into its own descendant.' })
        break
      }
      visited.add(current.parentId)
      const ancestor = allPages.get(current.parentId)
      if (!ancestor) break
      depth += 1
      if (depth > 3) {
        if (page.id === candidate.id || visited.has(candidate.id)) issues.push({ field: 'parentId', message: 'Page tree depth cannot exceed three levels, including this page.' })
        break
      }
      current = ancestor
    }
  }
  return uniqueIssues(issues)
}

/** Reject a section policy change that would strand existing pages. */
export function validateSectionTemplatePolicy(section: TreeSection, pages: readonly TreePage[]): FieldIssue[] {
  const incompatible = pages.filter((page) => page.sectionId === section.id && !section.allowedTemplates.includes(page.template))
  if (!incompatible.length) return []
  return [{
    field: 'allowedTemplates',
    message: `This policy would exclude existing pages: ${incompatible.map((page) => `${page.title ?? page.slug} (${page.template})`).join(', ')}. Move, convert, or remove those pages first.`,
  }]
}

/** Human-readable errors for block incompatibilities during template conversion. */
export function incompatibleBlocks(template: Template, blocks: readonly Block[]): FieldIssue[] {
  const allowed = TemplateAllowedBlocks[template]
  return blocks.flatMap((block, index) => allowed.includes(block.type)
    ? []
    : [{ field: `blocks.${index}.type`, message: `${block.type} is not allowed by ${template}. Remove or convert this block before changing templates.` }])
}

function uniqueIssues(issues: FieldIssue[]): FieldIssue[] {
  return issues.filter((issue, index) => issues.findIndex((other) => other.field === issue.field && other.message === issue.message) === index)
}
