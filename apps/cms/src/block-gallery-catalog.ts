import { z } from 'zod'
import { BlockSchemas, SectionPresets, TemplateAllowedBlocks, TemplateSchema, type Block } from '@site-engine/contract'
import { blockCatalog } from './block-gallery'

export type GalleryField = { path: string; type: string; required: boolean; limits: string; condition?: string }
type JsonField = { type?: string | string[]; properties?: Record<string, JsonField>; required?: string[]; items?: JsonField; enum?: unknown[]; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; minimum?: number; maximum?: number; format?: string; default?: unknown }

/** Generated from the contract itself so the catalogue cannot invent looser limits. */
export function contractFields(type: Block['type']): GalleryField[] {
  const schema = z.toJSONSchema(BlockSchemas[type], { io: 'input' }) as JsonField
  const fields: GalleryField[] = []
  function visit(object: JsonField, prefix = '', condition?: string) {
    for (const [name, field] of Object.entries(object.properties ?? {})) {
      if (!prefix && ['id', 'type', 'hidden', 'appearance'].includes(name)) continue
      const path = prefix ? `${prefix}.${name}` : name
      const limits = [field.minLength === undefined ? '' : `at least ${field.minLength} characters`, field.maxLength === undefined ? '' : `up to ${field.maxLength} characters`, field.minItems === undefined ? '' : `at least ${field.minItems} items`, field.maxItems === undefined ? '' : `up to ${field.maxItems} items`, field.minimum === undefined ? '' : `minimum ${field.minimum}`, field.maximum === undefined ? '' : `maximum ${field.maximum}`, field.enum ? field.enum.join(', ') : '', field.format ?? ''].filter(Boolean).join('; ')
      const required = Boolean(object.required?.includes(name))
      fields.push({ path, type: Array.isArray(field.type) ? field.type.join(' or ') : field.type ?? 'value', required, limits, ...(condition ? { condition } : {}) })
      const childCondition = required ? condition : path
      if (field.properties) visit(field, path, childCondition)
      if (field.items?.properties) visit(field.items, `${path}[]`, childCondition)
    }
  }
  visit(schema)
  return fields
}

const variants: Partial<Record<Block['type'], string[]>> = {
  featureGrid: ['2 items', '3 items', '4 items'],
  logoStrip: ['Default logos', 'Inverse logos'],
}
export const galleryCatalog = blockCatalog.map(block => ({ ...block, fields: contractFields(block.type), variants: variants[block.type] ?? ['Default'] }))

type Template = typeof TemplateSchema.options[number]
const generated: Record<Template, string[]> = {
  landing: ['Site header and footer'], standard: ['Page heading when no leading Hero is present'],
  listing: ['Page listing and navigation'], pillar: ['Page introduction', 'Child page listing when present'],
  service: ['Breadcrumbs', 'Service introduction', 'Child page listing when present', 'Last reviewed date when supplied'],
  article: ['Article title', 'Article information and supplied dates', 'Case study details when supplied'], job: ['Role heading and details', 'Application form'],
}
/** Valid recipe starting points; generated template parts never become editable blocks. */
const starting: Record<Template, Block['type'][]> = {
  landing: ['hero', 'featureGrid', 'faq', 'cta'], standard: ['hero', 'richText', 'cta'], listing: ['hero', 'cta'],
  pillar: ['featureGrid', 'cta'], service: ['featureGrid', 'splitList', 'callout', 'faq'], article: ['richText'], job: ['richText'],
}
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1)
export const templateCatalog = TemplateSchema.options.map(id => ({ id, label: label(id), allowedBlocks: [...TemplateAllowedBlocks[id]], generatedParts: generated[id], startingBlocks: starting[id] }))
export const sectionPresetCatalog = Object.entries(SectionPresets).map(([id, allowed]) => ({ id, label: label(id), allowedTemplates: [...allowed], landingTemplate: allowed[0], startingBlocks: starting[allowed[0]] }))
