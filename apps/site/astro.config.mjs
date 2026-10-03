import { defineConfig } from 'astro/config';
import { normalizeBasePath, normalizePublicOrigin } from './site-config.mjs';
const normalizedBase = normalizeBasePath(process.env.SITE_BASE_PATH ?? '/');
const base = normalizedBase === '/' ? undefined : normalizedBase.slice(0, -1);
normalizePublicOrigin(process.env.SITE_PUBLIC_ORIGIN ?? 'https://example.invalid');
export default defineConfig({ output: 'static', base, outDir: process.env.SITE_OUTPUT_DIR });
