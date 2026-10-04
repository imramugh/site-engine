export type FieldDiff = [field: string, before: unknown, after: unknown]
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const label = (value: unknown, index: number): string => object(value) ? String(value.heading || value.title || value.type || `Item ${index + 1}`) : `Item ${index + 1}`

/** Human-readable leaf changes, with ID-based matching for reordered blocks.
 * The bound keeps a pathological captured document from flooding the browser;
 * the final expandable row retains the complete values for inspection. */
export function fieldDiffs(before: unknown, after: unknown, limit = 200): FieldDiff[] {
  const result: FieldDiff[] = []
  let omitted = false
  const add = (path: string, left: unknown, right: unknown) => {
    if (result.length < limit) result.push([path, left, right])
    else omitted = true
  }
  const visit = (path: string, left: unknown, right: unknown): void => {
    if (JSON.stringify(left) === JSON.stringify(right)) return
    if (result.length >= limit) { omitted = true; return }
    if ((left != null && right != null) && (Array.isArray(left) !== Array.isArray(right) || object(left) !== object(right))) { add(path, left, right); return }
    if (Array.isArray(left) || Array.isArray(right)) {
      const previous = Array.isArray(left) ? left : [], next = Array.isArray(right) ? right : []
      if (!previous.length && !next.length) { add(path, left, right); return }
      const keyed = [...previous, ...next].every(item => object(item) && typeof item.id === 'string')
      if (keyed && previous.length + next.length) {
        const ids = [...new Set([...previous, ...next].map(item => item.id as string))]
        if (previous.map(item => item.id).join('\0') !== next.map(item => item.id).join('\0')) add(`${path} order`, previous.map(label), next.map(label))
        for (const id of ids) {
          const oldIndex = previous.findIndex(item => item.id === id), newIndex = next.findIndex(item => item.id === id)
          const item = next[newIndex] ?? previous[oldIndex]
          visit(`${path} › ${label(item, newIndex < 0 ? oldIndex : newIndex)}`, previous[oldIndex], next[newIndex])
        }
      } else {
        for (let index = 0; index < Math.max(previous.length, next.length); index++) visit(`${path} › Item ${index + 1}`, previous[index], next[index])
      }
      return
    }
    if (object(left) || object(right)) {
      const previous = object(left) ? left : {}, next = object(right) ? right : {}
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
      if (!keys.size) { add(path, left, right); return }
      for (const key of keys) visit(path ? `${path} › ${key}` : key, previous[key], next[key])
      return
    }
    add(path, left, right)
  }
  visit('', before, after)
  if (omitted) result.push(['Additional changes (complete values)', before, after])
  return result
}
