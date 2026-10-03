import type { Payload, PayloadRequest } from 'payload'
import { hasRole } from './access'
import { assetUsage } from './media'

type Actor = { id?: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }

export async function moveAssetToBin(payload: Payload, req: PayloadRequest, actor: Actor | undefined, assetId: string, now = new Date()): Promise<{ status: 'blocked'; usages: Awaited<ReturnType<typeof assetUsage>> } | { status: 'binned'; deleteAfter: string }> {
  if (!hasRole(actor, ['owner', 'editor'])) throw new Error('Editor role required.')
  const usages = await assetUsage(payload, req, assetId)
  if (usages.length) return { status: 'blocked', usages }
  const deleteAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await payload.update({ collection: 'assets', id: assetId, data: { deletedAt: now.toISOString(), deleteAfter }, overrideAccess: true, req, context: { mediaLifecycle: 'bin' } })
  return { status: 'binned', deleteAfter }
}

/** Restoration is a server-owned lifecycle transition, never an editable asset field. */
export async function restoreAssetFromBin(payload: Payload, req: PayloadRequest, actor: Actor | undefined, assetId: string): Promise<{ status: 'restored' }> {
  if (!hasRole(actor, ['owner', 'editor'])) throw new Error('Editor role required.')
  const asset = await payload.findByID({ collection: 'assets', id: assetId, depth: 0, overrideAccess: true, req }) as { deletedAt?: string | null }
  if (!asset.deletedAt) throw new Error('Asset is not in the deletion bin.')
  const usages = await assetUsage(payload, req, assetId)
  if (usages.length) throw new Error('An in-use asset cannot be restored through the deletion lifecycle.')
  await payload.update({ collection: 'assets', id: assetId, data: { deletedAt: null, deleteAfter: null }, overrideAccess: true, req, context: { mediaLifecycle: 'restore' } })
  return { status: 'restored' }
}
