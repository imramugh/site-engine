export type DirectEditField = 'heading' | 'body'

export type DirectEditCheck = {
  id: 'required' | 'length' | 'plain-text'
  label: string
  passed: boolean
}

const definitions = {
  hero: {
    heading: { maxLength: 120, selectors: ['h1'] },
    body: { maxLength: 1_000, selectors: ['h1 ~ p'] },
  },
} as const

export type DirectEditDefinition = {
  maxLength: number
  selectors: readonly string[]
}

export function directEditDefinition(blockType: string, field: string): DirectEditDefinition | undefined {
  if (blockType !== 'hero' || (field !== 'heading' && field !== 'body')) return undefined
  return definitions.hero[field]
}

export function uniqueDirectEditMatch<T>(candidates: readonly T[], matches: (candidate: T) => boolean): T | undefined {
  const exact = candidates.filter(matches)
  return exact.length === 1 ? exact[0] : undefined
}

export function directEditChecks(blockType: string, field: string, value: string): DirectEditCheck[] {
  const definition = directEditDefinition(blockType, field)
  if (!definition) return [
    { id: 'required', label: 'This rendered field is not available for direct editing.', passed: false },
  ]
  const trimmed = value.trim()
  const controls = field === 'heading'
    ? /[\u0000-\u001f]/
    : /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
  return [
    { id: 'required', label: 'Text is present and has no surrounding whitespace.', passed: Boolean(trimmed) && trimmed === value },
    { id: 'length', label: `${value.length} of ${definition.maxLength} characters`, passed: value.length <= definition.maxLength },
    { id: 'plain-text', label: 'Plain text contains no unsupported control characters.', passed: !controls.test(value) },
  ]
}

export function validDirectEditValue(blockType: string, field: string, value: string): boolean {
  return directEditChecks(blockType, field, value).every((check) => check.passed)
}
