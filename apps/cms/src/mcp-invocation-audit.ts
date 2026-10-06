import { randomUUID } from 'node:crypto'
import type { Payload } from 'payload'

type Invocation = {
  invocationId: string
  user: string
  clientIdHash: string
  sessionId: string
  method: string
  tool?: string
  scopes: string[]
  references: Record<string, unknown>
}

/** Keep invocation audit useful for correlation without copying caller content,
 * credentials, or an arbitrary tool payload into a long-lived audit record. */
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const changeKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function safeReferences(value: unknown, names: readonly string[]): Record<string, unknown> {
  const input = record(value); const references: Record<string, unknown> = {}
  for (const name of names) {
    const candidate = input[name]
    if (['expectedPageHash', 'expectedChangeHash', 'pageHash', 'changeHash', 'contentHash'].includes(name) && hash(candidate)) references[name] = candidate
    else if (['expectedRevision', 'expectedChangeSetRevision', 'revision', 'changeSetRevision'].includes(name) && revision(candidate)) references[name] = candidate
    else if (name === 'cursor' && typeof candidate === 'string' && /^p:[1-9][0-9]{0,5}$/.test(candidate)) references[name] = candidate
    else if (name === 'includedChangeKeys' && Array.isArray(candidate) && candidate.length <= 100 && candidate.every(changeKey)) references[name] = candidate
    else if (uuid(candidate)) references[name] = candidate
  }
  return references
}

export function invocationRequestReferences(value: unknown): Record<string, unknown> {
  return safeReferences(value, ['id', 'pageId', 'sectionId', 'changeSetId', 'blockId', 'sourcePageId', 'sourceBlockId', 'assetId', 'draftID', 'grantID', 'jobId', 'requestKey', 'expectedPageHash', 'expectedChangeHash', 'expectedRevision', 'expectedChangeSetRevision', 'cursor', 'includedChangeKeys'])
}

export function invocationResultReferences(value: unknown): Record<string, unknown> {
  const output = record(value)
  return { ...safeReferences(output, ['id', 'pageId', 'changeSetId', 'jobId', 'pageHash', 'changeHash', 'contentHash', 'revision', 'changeSetRevision', 'includedChangeKeys']), ...safeReferences(output.draft, ['pageId', 'changeSetId', 'pageHash', 'changeSetRevision']) }
}

export function containsOverrideAccess(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsOverrideAccess)
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => key === 'overrideAccess' || containsOverrideAccess(child))
}

export function newInvocation(input: Omit<Invocation, 'invocationId'>): Invocation {
  return { invocationId: randomUUID(), ...input }
}

export async function auditInvocationStart(payload: Payload, invocation: Invocation): Promise<void> {
  await payload.create({ collection: 'audit-events', data: { event: 'mcp.request', user: invocation.user, actor: invocation.user, detail: { invocationId: invocation.invocationId, clientIdHash: invocation.clientIdHash, sessionId: invocation.sessionId, method: invocation.method, ...(invocation.tool ? { tool: invocation.tool } : {}), scopes: invocation.scopes, references: invocation.references, state: 'started' } }, overrideAccess: true })
}

export async function auditInvocationResult(payload: Payload, invocation: Invocation, result: 'success' | 'tool_error' | 'schema_error' | 'unknown' | 'denied', responseReferences: Record<string, unknown> = {}): Promise<void> {
  await payload.create({ collection: 'audit-events', data: { event: 'mcp.result', user: invocation.user, actor: invocation.user, detail: { invocationId: invocation.invocationId, clientIdHash: invocation.clientIdHash, sessionId: invocation.sessionId, method: invocation.method, ...(invocation.tool ? { tool: invocation.tool } : {}), scopes: invocation.scopes, references: { ...invocation.references, ...responseReferences }, result } }, overrideAccess: true })
}
