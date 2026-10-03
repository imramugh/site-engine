import type { Block, SiteSnapshot } from '@site-engine/contract';

export const starterTheme = { name: 'starter', contract: '1.0.0' as const };
export function blockLabel(block: Block): string { return block.type; }
export function themeCanRender(snapshot: SiteSnapshot): boolean { return snapshot.settings.contractVersion === starterTheme.contract; }
