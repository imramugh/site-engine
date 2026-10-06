import { readFileSync } from 'node:fs';
import { ThemeManifestSchema, type Block } from '@site-engine/contract';
import { projectThemeMotion } from '@site-engine/engine/theme-registry';
import { starterTheme } from '@site-engine/theme-starter';

const starterMotion = { motion: { presets: [...starterTheme.motion.supportedPresets], intentFallbacks: { ...starterTheme.motion.intentFallbacks } } };

function targetMotionManifest() {
  const source = process.env.SITE_THEME_MOTION_PATH;
  return source ? ThemeManifestSchema.parse(JSON.parse(readFileSync(source, 'utf8'))) : starterMotion;
}

/** Projects source content to the target theme without changing the frozen snapshot. */
export function projectThemeBlock(block: Block): Block {
  return projectThemeMotion(block, targetMotionManifest()).block;
}

/** Resolves host props from the same target projection passed to theme renderers. */
export function resolveStarterMotion(block: Block): string | undefined {
  return projectThemeMotion(block, targetMotionManifest()).motionPreset;
}

export function pageHasEnabledMotion(blocks: readonly Block[]): boolean {
  return blocks.some((block) => resolveStarterMotion(block) !== undefined);
}
