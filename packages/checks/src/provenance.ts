import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const denied = [/\b(?:customer|client)[-_ ]?(?:name|asset|fixture)\b/i, /https?:\/\/[^\s]+\.(?:internal|local)\b/i];
const ignored = new Set(['node_modules', '.git', 'dist', '.astro', '.next', 'artifacts', 'data']);
const oauthProtocolFields = new Set(['apps/oauth/src/server.ts', 'apps/oauth/tests/protocol.test.ts']);

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.filter((entry) => !ignored.has(entry.name)).map(async (entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

export async function inspectPublicProvenance(root: string): Promise<string[]> {
  const roots = ['apps', 'packages', 'README.md', 'docs', 'package.json'];
  const targets = (await Promise.all(roots.map(async (item) => { const target = join(root, item); try { return (await stat(target)).isDirectory() ? files(target) : [target]; } catch { return []; } }))).flat();
  const findings: string[] = [];
  for (const file of targets) {
    const path = relative(root, file);
    let content = await readFile(file, 'utf8').catch(() => '');
    // RFC 7591's DCR display-name metadata key is allowed only in the OAuth
    // protocol implementation and its direct protocol test.
    if (oauthProtocolFields.has(path)) content = content.replaceAll('client' + '_name', '');
    for (const pattern of denied) if (pattern.test(content)) findings.push(`${path}: ${pattern}`);
  }
  return findings;
}
