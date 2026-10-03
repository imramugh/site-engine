import { ThemeInstallSchema, type SiteSnapshot, type Block } from '@site-engine/contract';

export function validateThemeInstall(input: unknown) { return ThemeInstallSchema.safeParse(input); }
export function visibleBlocks(snapshot: SiteSnapshot): Block[] { return snapshot.pages.filter((page) => page.status === 'published').flatMap((page) => page.blocks).filter((block) => !block.hidden); }
