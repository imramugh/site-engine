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
  await run(consumer, ["install", "--offline", "--ignore-scripts"]);
  const cli = join(consumer, "node_modules/@site-engine/theme-conformance/scripts/theme-conformance.mjs");
  const evidence = join(temp, "evidence");
  const positive = await execFile(process.execPath, [cli, "@site-engine/theme-starter", "--artifacts-dir", evidence], { cwd: consumer });
  const result = JSON.parse(positive.stdout.trim().split("\n").at(-1)); if (result.blocks !== 18 || result.cases !== 14) throw new Error(`Unexpected packed result: ${positive.stdout}`);
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
