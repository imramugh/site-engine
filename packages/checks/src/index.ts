import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withIsolatedSqlitePath<T>(run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'site-engine-sqlite-'));
  try { return await run(join(directory, 'cms.sqlite')); } finally { await rm(directory, { recursive: true, force: true }); }
}
export const artifactName = (story: string, browser: string, test: string) => `${story}-${browser}-${test.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

export { assertBoundaries, inspectBoundaries } from './assert-boundaries.js';
