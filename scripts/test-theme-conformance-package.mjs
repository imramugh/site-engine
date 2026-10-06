#!/usr/bin/env node
/** Exercise the published-package boundary; do not replace this with workspace imports. */
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(new URL("..", import.meta.url).pathname);
const run = (cwd, args) => execFile("corepack", ["pnpm@12.8.1", ...args], { cwd, maxBuffer: 10_000_000 });
const tarball = async (directory, destination) => { await run(join(root, directory), ["pack", "--pack-destination", destination]); };
const file = async (directory, prefix) => {
  const items = await (await import("node:fs/promises")).readdir(directory);
  const item = items.find((name) => name.startsWith(prefix) && name.endsWith(".tgz"));
  if (!item) throw new Error(`Missing packed ${prefix}`);
  return `file:${join(directory, item)}`;
};

const temp = await mkdtemp(join(tmpdir(), "site-engine-packed-conformance-"));
try {
  const packs = join(temp, "packs"); await mkdir(packs);
  for (const packageDir of ["packages/contract", "packages/engine", "packages/theme-starter", "packages/theme-conformance"]) await tarball(packageDir, packs);
  const zod = join(root, "node_modules/.pnpm/zod@4.6.5/node_modules/zod"); await run(zod, ["pack", "--pack-destination", packs]);
  const contract = await file(packs, "site-engine-contract-"); const engine = await file(packs, "site-engine-engine-"); const starter = await file(packs, "site-engine-theme-starter-"); const harness = await file(packs, "site-engine-theme-conformance-"); const zodTar = await file(packs, "zod-");
  const consumer = join(temp, "consumer"); await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "packed-theme-conformance-consumer", private: true, dependencies: { "@site-engine/contract": contract, "@site-engine/engine": engine, "@site-engine/theme-starter": starter, "@site-engine/theme-conformance": harness } }));
  await writeFile(join(consumer, "pnpm-workspace.yaml"), `overrides:\n  '@site-engine/contract': '${contract}'\n  '@site-engine/engine': '${engine}'\n  '@site-engine/theme-starter': '${starter}'\n  zod: '${zodTar}'\n`);
  // Seed an isolated store first, then prove the packed consumer can be
  // recreated with networking disabled. GitHub runners start with no package
  // metadata cache, so an unseeded --offline install tests cache warmth rather
  // than the published package boundary.
  const store = join(temp, "store");
  await run(consumer, ["install", "--ignore-scripts", "--store-dir", store]);
  await rm(join(consumer, "node_modules"), { recursive: true, force: true });
  await run(consumer, ["install", "--offline", "--ignore-scripts", "--store-dir", store]);
  const cli = join(consumer, "node_modules/@site-engine/theme-conformance/scripts/theme-conformance.mjs");
  const evidence = join(temp, "evidence");
  const positive = await execFile(process.execPath, [cli, "@site-engine/theme-starter", "--artifacts-dir", evidence], { cwd: consumer });
  const result = JSON.parse(positive.stdout.trim().split("\n").at(-1)); if (result.blocks !== 18 || result.cases !== 14) throw new Error(`Unexpected packed result: ${positive.stdout}`);
  const checkerLogo = join(consumer, "node_modules/@site-engine/theme-conformance/harness/public/media/sample-logo.svg");
  const validLogo = await readFile(checkerLogo, "utf8");
  // A white glyph on the default paper surface must fail even though the image
  // loads successfully. This protects against inverse-tone CSS leaking into
  // the paper logo slot.
  await writeFile(checkerLogo, '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><path d="M48 24h144v72H48z" fill="#fff"/></svg>');
  await execFile(process.execPath, [cli, "@site-engine/theme-starter", "--artifacts-dir", join(temp, "invisible-logo")], { cwd: consumer }).then(() => { throw new Error("Packed CLI accepted an invisible inverse logo glyph."); }, error => { if (!String(error.stderr).includes("logoVisibility")) throw error; });
  // A full-surface rectangle is paint, not a logo glyph.
  await writeFile(checkerLogo, '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="#14212b"/></svg>');
  await execFile(process.execPath, [cli, "@site-engine/theme-starter", "--artifacts-dir", join(temp, "solid-logo")], { cwd: consumer }).then(() => { throw new Error("Packed CLI accepted a solid rectangle as a logo glyph."); }, error => { if (!String(error.stderr).includes("logoVisibility")) throw error; });
  await writeFile(checkerLogo, validLogo);
  const hidden = join(temp, "hidden-logo-theme");
  await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), hidden, { recursive: true });
  const hiddenLayout = join(hidden, "src/components/Layout.astro");
  await writeFile(hiddenLayout, `${await readFile(hiddenLayout, "utf8")}\n<style is:global>.logo-media > .media { opacity: 0 !important; }</style>\n`);
  await execFile(process.execPath, [cli, hidden, "--artifacts-dir", join(temp, "hidden-logo")], { cwd: consumer }).then(() => { throw new Error("Packed CLI accepted a hidden logo glyph."); }, error => { if (!String(error.stderr).includes("logoVisibility")) throw error; });
  const blackedOut = join(temp, "blacked-out-logo-theme");
  await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), blackedOut, { recursive: true });
  const blackedOutLayout = join(blackedOut, "src/components/Layout.astro");
  await writeFile(blackedOutLayout, `${await readFile(blackedOutLayout, "utf8")}\n<style is:global>section[data-block="logoStrip"] { filter: brightness(0) !important; }</style>\n`);
  await execFile(process.execPath, [cli, blackedOut, "--artifacts-dir", join(temp, "blacked-out-logo")], { cwd: consumer }).then(() => { throw new Error("Packed CLI accepted a logo blacked out with its parent surface."); }, error => { if (!String(error.stderr).includes("logoVisibility")) throw error; });
  const nearlyTransparent = join(temp, "nearly-transparent-logo-theme");
  await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), nearlyTransparent, { recursive: true });
  const nearlyTransparentLayout = join(nearlyTransparent, "src/components/Layout.astro");
  await writeFile(nearlyTransparentLayout, `${await readFile(nearlyTransparentLayout, "utf8")}\n<style is:global>section[data-block="logoStrip"] .logo-media { opacity: .001 !important; }</style>\n`);
  await execFile(process.execPath, [cli, nearlyTransparent, "--artifacts-dir", join(temp, "nearly-transparent-logo")], { cwd: consumer }).then(() => { throw new Error("Packed CLI accepted a nearly transparent nested logo wrapper."); }, error => { if (!String(error.stderr).includes("logoVisibility")) throw error; });
  const nested = join(temp, "nested-logo-surface-theme");
  await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), nested, { recursive: true });
  const nestedRenderer = join(nested, "src/components/BlockRenderer.astro");
  const nestedSource = await readFile(nestedRenderer, "utf8");
  const wrapped = nestedSource
    .replace('<section class={classes} id={block.anchorId} data-block={block.type} data-block-id={block.id} data-background={block.appearance.background} data-logo-tone={block.appearance.logoTone} data-motion-intent={block.appearance.motionIntent} data-motion-effect={effect}>', '<div data-logo-tone={block.appearance.logoTone}><section class={classes} id={block.anchorId} data-block={block.type} data-block-id={block.id} data-background={block.appearance.background} data-motion-intent={block.appearance.motionIntent} data-motion-effect={effect}>')
    .replace('</div></section>}', '</div></section></div>}');
  if (wrapped === nestedSource) throw new Error("Nested logo surface fixture did not modify the starter renderer.");
  await writeFile(nestedRenderer, wrapped);
  await execFile(process.execPath, [cli, nested, "--artifacts-dir", join(temp, "nested-logo-surface"), "--baseline-file", join(temp, "nested-logo-surface.json"), "--record-baselines"], { cwd: consumer });
  const filtered = join(temp, "filtered-logo-surface-theme");
  await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), filtered, { recursive: true });
  const filteredLayout = join(filtered, "src/components/Layout.astro");
  await writeFile(filteredLayout, `${await readFile(filteredLayout, "utf8")}\n<style is:global>section[data-block="logoStrip"] { filter: brightness(.9) !important; }</style>\n`);
  await execFile(process.execPath, [cli, filtered, "--artifacts-dir", join(temp, "filtered-logo-surface"), "--baseline-file", join(temp, "filtered-logo-surface.json"), "--record-baselines"], { cwd: consumer });
  const bad = join(temp, "bad-theme"); await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), bad, { recursive: true });
  const manifest = JSON.parse(await readFile(join(bad, "theme.json"), "utf8")); delete manifest.contractSurface.components.blockRenderer; await writeFile(join(bad, "theme.json"), JSON.stringify(manifest));
  await execFile(process.execPath, [cli, bad, "--artifacts-dir", join(temp, "bad-evidence")], { cwd: consumer }).then(() => { throw new Error("Packed CLI accepted a missing blockRenderer."); }, error => { if (!String(error.stderr).includes("blockRenderer")) throw error; });
  const custom = join(temp, "custom-theme"); await cp(await realpath(join(consumer, "node_modules/@site-engine/theme-starter")), custom, { recursive: true });
  const customManifest = JSON.parse(await readFile(join(custom, "theme.json"), "utf8")); customManifest.name = "neutral-custom"; await writeFile(join(custom, "theme.json"), JSON.stringify(customManifest));
  await execFile(process.execPath, [cli, custom, "--artifacts-dir", join(temp, "custom-missing-baseline")], { cwd: consumer }).then(() => { throw new Error("Packed CLI allowed an unowned custom baseline."); }, error => { if (!String(error.stderr).includes("No visual baseline")) throw error; });
  const customBaseline = join(temp, "custom-baseline.json");
  const customResult = await execFile(process.execPath, [cli, custom, "--artifacts-dir", join(temp, "custom"), "--baseline-file", customBaseline, "--record-baselines"], { cwd: consumer });
  if (JSON.parse(customResult.stdout.trim().split("\n").at(-1)).cases !== 14) throw new Error("Custom package path did not resolve through the installed CLI.");
  const baselineA = join(temp, "baseline-a.json"), baselineB = join(temp, "baseline-b.json");
  await execFile(process.execPath, [cli, "@site-engine/theme-starter", "--artifacts-dir", join(temp, "a"), "--baseline-file", baselineA, "--record-baselines"], { cwd: consumer });
  await execFile(process.execPath, [cli, "@site-engine/theme-starter", "--artifacts-dir", join(temp, "b"), "--baseline-file", baselineB, "--record-baselines"], { cwd: consumer });
  if ((await readFile(baselineA, "utf8")) !== (await readFile(baselineB, "utf8"))) throw new Error("Independent baseline recordings diverged.");
  await writeFile(join(temp, "result.json"), `${JSON.stringify({ blocks: result.blocks, cases: result.cases, negative: "blockRenderer", baselineFiles: 3, customPackage: true }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ blocks: result.blocks, cases: result.cases, negative: "blockRenderer", baselineFiles: 3, customPackage: true })}\n`);
} finally { await rm(temp, { recursive: true, force: true }); }
