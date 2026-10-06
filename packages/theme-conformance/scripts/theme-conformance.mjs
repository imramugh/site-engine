#!/usr/bin/env node
import { resolve } from "node:path";
import { runThemeConformance } from "../src/index.mjs";

const args = process.argv.slice(2);
let themePackage = "@site-engine/theme-starter";
let artifactsDir;
let updateBaselines = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--artifacts-dir") artifactsDir = resolve(args[++index] || "");
  else if (arg === "--update-baselines") updateBaselines = true;
  else if (!arg.startsWith("-")) themePackage = arg;
  else throw new Error(`Unknown option: ${arg}`);
}
runThemeConformance({ themePackage, artifactsDir, updateBaselines }).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; },
);
