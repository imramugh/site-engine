import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const denied = [/\b(?:customer|client)[-_ ]?(?:name|asset|fixture)\b/i, /https?:\/\/[^\s]+\.(?:internal|local)\b/i];
const ignored = new Set(['node_modules', '.git', 'dist', '.astro', '.next', 'artifacts', 'data']);
const oauthProtocolFields = new Set([
  'apps/oauth/src/server.ts', 'apps/oauth/src/adapter.ts',
  'apps/oauth/tests/protocol.test.ts', 'apps/oauth/tests/grant-management.test.ts',
  'apps/cms/src/connected-assistants.ts', 'apps/cms/tests/connected-assistants.integration.test.ts',
  'apps/cms/tests/oauth-bridge.integration.test.ts', 'apps/cms/e2e/connected-assistants.spec.ts',
  'apps/cms/app/(staff)/integrations/integration-configuration.tsx',
]);

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
    // RFC 7591's display-name metadata and its typed DTO spelling are allowed
    // only in the protocol/grant-management implementation and direct tests.
    // Other customer markers remain denied, including in these exact files.
    if (oauthProtocolFields.has(path)) content = content.replace(new RegExp('\\bclient(?:_name|Name)\\b', 'g'), '');
    for (const pattern of denied) if (pattern.test(content)) findings.push(`${path}: ${pattern}`);
  }
  return findings;
}
