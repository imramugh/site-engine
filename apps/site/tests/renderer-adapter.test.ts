import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRenderer } from '../scripts/renderer-adapter.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('trusted renderer module loader', () => {
  it('uses generic rendering when unconfigured', async () => {
    const generic = async () => ({ output: 'generic', manifest: {} });
    expect(await loadRenderer({ genericRenderer: generic })).toBe(generic);
  });

  it('validates the configured module up front, then dispatches legacy and selected snapshots', async () => {
    const genericCalls: unknown[] = [];
    const generic = async (options: unknown) => {
      genericCalls.push(options);
      return { output: 'generic', manifest: { renderer: 'generic' } };
    };
    const root = await mkdtemp(join(tmpdir(), 'renderer-module-')); roots.push(root);
    const module = join(root, 'renderer.mjs');
    await writeFile(module, `
      export async function buildSnapshot(options) {
        if (options.themeSelection.id === 'failing-theme') throw new Error('selected renderer failed');
        return { output: 'selected', manifest: { renderer: 'selected', received: options.themeSelection } };
      }
    `);
    const renderer = await loadRenderer({ modulePath: module, genericRenderer: generic });

    const live = await renderer({ input: '/live.json', outputRoot: '/live', publicOrigin: 'https://example.test', basePath: '/preview/changes/1/live/', versionPins: { engineVersion: '1.0.0' } });
    const proposed = await renderer({ input: '/proposed.json', outputRoot: '/proposed', publicOrigin: 'https://example.test', basePath: '/preview/changes/1/proposed/', themeSelection: { id: 'sample-theme', version: '1.0.0', contract: 'v1', manifestDigest: 'a'.repeat(64) }, versionPins: { engineVersion: '1.0.0' } });

    expect(live).toMatchObject({ output: 'generic', manifest: { renderer: 'generic' } });
    expect(proposed).toMatchObject({ output: 'selected', manifest: { renderer: 'selected', received: { id: 'sample-theme' } } });
    expect(genericCalls).toHaveLength(1);
    await expect(renderer({ themeSelection: { id: 'failing-theme' } })).rejects.toThrow('selected renderer failed');
    expect(genericCalls).toHaveLength(1);
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
