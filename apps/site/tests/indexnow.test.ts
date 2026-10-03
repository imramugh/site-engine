import { afterEach, describe, expect, it, vi } from 'vitest';
import { crawlerMode } from '../src/lib/crawler-config.js';

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; vi.unstubAllGlobals(); });

describe('ENG-012 IndexNow hook', () => {
  it('never marks a mounted preview as public', () => {
    expect(crawlerMode('/preview/changes/', 'public')).toBe('preview');
  });

  it('does not send from development or preview builds', async () => {
    process.env.NODE_ENV = 'development'; process.env.SITE_INDEXNOW_ENABLED = 'true';
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { publishIndexNow } = await import('../scripts/indexnow.mjs');
    await expect(publishIndexNow({ urls: ['https://public.example.test/'], publicOrigin: 'https://public.example.test', basePath: '/' })).resolves.toMatchObject({ sent: false });
    process.env.NODE_ENV = 'production';
    await expect(publishIndexNow({ urls: ['https://public.example.test/'], publicOrigin: 'https://public.example.test', basePath: '/preview/' })).resolves.toMatchObject({ reason: 'preview' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires an allowlisted HTTPS endpoint before sending production URLs', async () => {
    process.env.NODE_ENV = 'production'; process.env.SITE_INDEXNOW_ENABLED = 'true'; process.env.SITE_INDEXNOW_KEY = 'abcdefghi';
    process.env.SITE_INDEXNOW_ENDPOINT = 'https://api.indexnow.example/indexnow'; process.env.SITE_INDEXNOW_ALLOWED_HOSTS = 'api.indexnow.example';
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
    const { publishIndexNow } = await import('../scripts/indexnow.mjs');
    await expect(publishIndexNow({ urls: ['https://public.example.test/guide'], publicOrigin: 'https://public.example.test', basePath: '/' })).resolves.toEqual({ sent: true, status: 202 });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(publishIndexNow({ urls: ['https://other.example.test/'], publicOrigin: 'https://public.example.test', basePath: '/' })).rejects.toThrow('configured HTTPS public origin');
  });
});
