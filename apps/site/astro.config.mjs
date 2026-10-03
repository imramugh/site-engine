import { defineConfig } from 'astro/config';
import { normalizeBasePath, normalizePublicOrigin } from './site-config.mjs';
const normalizedBase = normalizeBasePath(process.env.SITE_BASE_PATH ?? '/');
const base = normalizedBase === '/' ? undefined : normalizedBase.slice(0, -1);
normalizePublicOrigin(process.env.SITE_PUBLIC_ORIGIN ?? 'https://example.invalid');
export default defineConfig({ output: 'static', build: { inlineStylesheets: 'never' }, base, outDir: process.env.SITE_OUTPUT_DIR, cacheDir: process.env.SITE_CACHE_DIR, vite: { resolve: { alias: process.env.SITE_THEME_COMPONENT_ROOT ? { '@site-engine/theme-starter/components': process.env.SITE_THEME_COMPONENT_ROOT } : {} }, cacheDir: process.env.SITE_CACHE_DIR ? `${process.env.SITE_CACHE_DIR}/vite` : undefined } });
