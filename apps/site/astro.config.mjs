import { defineConfig } from 'astro/config';
const base = process.env.SITE_BASE_PATH && process.env.SITE_BASE_PATH !== '/' ? `/${process.env.SITE_BASE_PATH.replace(/^\/+|\/+$/g, '')}` : undefined;
export default defineConfig({ output: 'static', base, outDir: process.env.SITE_OUTPUT_DIR });
