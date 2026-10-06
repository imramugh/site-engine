import type { Block } from '@site-engine/contract';
import { resolveMotionPreset } from '@site-engine/engine/motion';
import { starterTheme } from '@site-engine/theme-starter';

const supportedPresets = new Set(starterTheme.motion.supportedPresets);
const intentFallbacks = new Map(Object.entries(starterTheme.motion.intentFallbacks));

/** Resolves app-owned motion props without coupling the starter theme to engine code. */
export function resolveStarterMotion(block: Block): string | undefined {
  if (block.hidden || block.type === 'contact' || block.type === 'incidentBar') return undefined;
  return resolveMotionPreset(block.appearance.motionIntent, block.appearance.motionPreset, supportedPresets, intentFallbacks);
}

export function pageHasEnabledMotion(blocks: readonly Block[]): boolean {
  return blocks.some((block) => resolveStarterMotion(block) !== undefined);
}
