import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRenderer } from '../scripts/renderer-adapter.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('trusted renderer module loader', () => {
  it('uses generic rendering when unconfigured and loads only an absolute module exporting buildSnapshot', async () => {
    const generic = async () => ({ output: 'generic', manifest: {} });
    expect(await loadRenderer({ genericRenderer: generic })).toBe(generic);
    const root = await mkdtemp(join(tmpdir(), 'renderer-module-')); roots.push(root);
    const module = join(root, 'renderer.mjs');
    await writeFile(module, 'export async function buildSnapshot(options) { return { output: options.outputRoot, manifest: { received: options } }; }\n');
    const renderer = await loadRenderer({ modulePath: module, genericRenderer: generic });
    await expect(renderer({ input: '/frozen.json', outputRoot: '/artifact', publicOrigin: 'https://example.test', basePath: '/', versionPins: { engineVersion: '1.0.0' } })).resolves.toMatchObject({ output: '/artifact', manifest: { received: { input: '/frozen.json', basePath: '/' } } });
  });

  it('fails closed for relative, missing-export, and unloadable modules', async () => {
    const generic = async () => ({ output: 'generic', manifest: {} });
    await expect(loadRenderer({ modulePath: 'relative.mjs', genericRenderer: generic })).rejects.toMatchObject({ code: 'INVALID_RENDERER_MODULE' });
    const root = await mkdtemp(join(tmpdir(), 'renderer-module-')); roots.push(root);
    const missingExport = join(root, 'missing-export.mjs');
    const unloadable = join(root, 'unloadable.mjs');
    await writeFile(missingExport, 'export const nope = true;\n');
    await writeFile(unloadable, 'throw new Error("unloadable");\n');
    await expect(loadRenderer({ modulePath: missingExport, genericRenderer: generic })).rejects.toMatchObject({ code: 'INVALID_RENDERER_MODULE' });
    await expect(loadRenderer({ modulePath: unloadable, genericRenderer: generic })).rejects.toMatchObject({ code: 'INVALID_RENDERER_MODULE' });
  });
});
