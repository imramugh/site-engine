import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { artifactName, withIsolatedSqlitePath } from '../src/index.js';
describe('ENG-028 regression helpers', () => {
  it('names artifacts without fixture text', () => expect(artifactName('ENG-028', 'chromium', 'home page is accessible')).toBe('ENG-028-chromium-home-page-is-accessible'));
  it('creates and removes an isolated SQLite location', async () => { let database = ''; await withIsolatedSqlitePath(async (path) => { database = path; await expect(access(path)).rejects.toThrow(); }); await expect(access(database)).rejects.toThrow(); });
});
