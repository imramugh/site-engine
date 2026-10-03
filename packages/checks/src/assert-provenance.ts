import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
// Client provenance markers belong in the private ops policy.  Public source never
// contains the marker list, so the scanner cannot itself disclose or self-match it.
const denied = [/\b(?:customer|client)[-_ ]?(?:name|asset|fixture)\b/i, /https?:\/\/[^\s]+\.(?:internal|local)\b/i];
const ignored = new Set(['node_modules', '.git', 'dist', '.astro', '.next', 'artifacts', 'data']);
async function files(directory: string): Promise<string[]> { const entries = await readdir(directory, { withFileTypes: true }); const nested = await Promise.all(entries.filter((entry) => !ignored.has(entry.name)).map(async (entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])); return nested.flat(); }
const scanRoots = ['apps', 'packages', 'README.md', 'docs', 'package.json'];
const targets = (await Promise.all(scanRoots.map(async (item) => { const target = join(root, item); try { return (await (await import('node:fs/promises')).stat(target)).isDirectory() ? files(target) : [target]; } catch { return []; } }))).flat();
const findings: string[] = [];
for (const file of targets) { const content = await readFile(file, 'utf8').catch(() => ''); for (const pattern of denied) if (pattern.test(content)) findings.push(`${file.replace(root + '/', '')}: ${pattern}`); }
if (findings.length) throw new Error(`Public provenance violations:\n${findings.join('\n')}`);
console.log('public sources contain no prohibited provenance markers');
