import { isInlineTextTarget, type Block } from '@site-engine/contract'

export type PreviewEditableField = 'eyebrow' | 'heading' | 'body'

export function isPreviewEditableField(block: Block, field: string): field is PreviewEditableField {
  return isInlineTextTarget(block, field) && typeof (block as unknown as Record<string, unknown>)[field] === 'string'
}
