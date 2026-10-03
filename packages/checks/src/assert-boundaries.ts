import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const forbidden: Record<string, string[]> = { '@site-engine/theme-starter': ['@site-engine/cms', '@site-engine/engine'], '@site-engine/contract': ['@site-engine/cms', '@site-engine/engine', '@site-engine/theme-starter'] };
let errors: string[] = [];
for (const [packageName, banned] of Object.entries(forbidden)) {
  const folder = packageName.split('/')[1];
  const manifest = JSON.parse(await readFile(join(root, 'packages', folder, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const dependency of banned) if (dependency in (manifest.dependencies ?? {})) errors.push(`${packageName} must not import ${dependency}`);
}
async function sourceFiles(directory: string): Promise<string[]> { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [join(directory, entry.name)] : []))).flat(); }
for (const [packageName, banned] of Object.entries(forbidden)) { const folder = packageName.split('/')[1].replace('theme-starter', 'theme-starter'); for (const file of await sourceFiles(join(root, 'packages', folder, 'src'))) { const source = await readFile(file, 'utf8'); for (const dependency of banned) if (source.includes(`from '${dependency}'`) || source.includes(`from \"${dependency}\"`)) errors.push(`${file.replace(root + '/', '')} imports prohibited ${dependency}`); } }
if (errors.length) throw new Error(`Dependency boundary violations:\n${errors.join('\n')}`);
console.log('workspace dependency boundaries are valid');
