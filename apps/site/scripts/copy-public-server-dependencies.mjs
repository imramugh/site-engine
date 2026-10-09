import { createRequire } from 'node:module';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

async function packageRoot(name, entry) {
  let current = dirname(entry);
  while (current !== dirname(current)) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
      if (manifest.name === name) return { root: current, manifest };
    } catch {}
    current = dirname(current);
  }
  throw new Error(`Could not locate package root for ${name}.`);
}

async function copyPackage(name, target, copied, entry = require.resolve(name)) {
  if (copied.has(name)) return;
  const source = await packageRoot(name, entry);
  copied.add(name);
  await mkdir(join(target, dirname(name)), { recursive: true });
  await cp(source.root, join(target, name), { recursive: true, dereference: true, force: true });
  const packageRequire = createRequire(join(source.root, 'package.json'));
  for (const dependency of Object.keys(source.manifest.dependencies ?? {}).sort()) {
    // Resolve from the copied package's installed dependency graph, never from
    // an ambient application dependency with a different version.
    await copyPackage(dependency, target, copied, packageRequire.resolve(dependency));
  }
}

/** Copy the small runtime closure needed by public-server.mjs into node_modules. */
export async function copyPublicServerDependencies(target) {
  const destination = resolve(target);
  const copied = new Set();
  await copyPackage('parse5', destination, copied);
  return { target: destination, packages: [...copied].sort() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const target = process.argv[2];
  if (!target || process.argv.length !== 3) throw new Error('Usage: node copy-public-server-dependencies.mjs <target-node_modules>');
  process.stdout.write(`${JSON.stringify(await copyPublicServerDependencies(target))}\n`);
}
