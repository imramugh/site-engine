import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { artifactName, scrubFailureLog } from '../packages/checks/src/index.js'

const require = createRequire(import.meta.url)
const playwrightTest = require.resolve('@playwright/test')
const playwrightCli = require.resolve('@playwright/test/cli')

async function files(directory: string, root = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path, root) : [relative(root, path)]
  }))).flat()
}

async function run(command: string, args: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, output }))
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'site-engine-eng028-browser-'))
  try {
    const tests = join(root, 'tests'); const artifacts = join(root, 'artifacts')
    await mkdir(tests, { recursive: true })
    await writeFile(join(root, 'playwright.config.mjs'), `import playwright from ${JSON.stringify(playwrightTest)};
const { defineConfig } = playwright;
export default defineConfig({ testDir: './tests', outputDir: './artifacts/test-results', reporter: [['line']], use: { browserName: 'chromium', trace: 'on', screenshot: 'on', video: 'on' } });
`)
    await writeFile(join(root, 'tests', 'intentional-failure.spec.mjs'), `import playwright from ${JSON.stringify(playwrightTest)};
const { test, expect } = playwright;
test('ENG-028 intentionally retains neutral failure proof', async ({ page }) => {
  console.error('Authorization: Bearer synthetic-eng028-browser-token');
  await page.setContent('<main><h1>Neutral browser fixture</h1></main>');
  await expect(page.getByRole('heading')).toHaveText('Expected heading that is intentionally absent');
});
`)
    const result = await run(process.execPath, [playwrightCli, 'test', '--config', join(root, 'playwright.config.mjs')], root)
    assert.notEqual(result.exitCode, 0, 'The isolated failure fixture must fail so Playwright retains diagnostics.')
    const retained = await files(artifacts).catch((error: unknown) => { throw new Error(`Expected the isolated browser failure to create an artifact root. Playwright output:\n${result.output}`, { cause: error }) })
    assert(retained.some((file) => file.endsWith('.zip')), `Expected a retained trace archive, found: ${retained.join(', ')}`)
    assert(retained.some((file) => file.endsWith('.png')), `Expected a retained screenshot, found: ${retained.join(', ')}`)
    assert(retained.some((file) => file.endsWith('.webm')), `Expected a retained video, found: ${retained.join(', ')}`)
    const exportedLog = scrubFailureLog(result.output)
    assert(!exportedLog.includes('synthetic-eng028-browser-token'), 'Exported failure logs must redact authorization values.')
    const proofName = artifactName('ENG-028', 'chromium', 'intentional failing browser fixture')
    await writeFile(join(artifacts, `${proofName}.log`), exportedLog)
    const proof = { story: 'ENG-028', result: 'expected-failure-retained', artifacts: retained.sort(), log: `${proofName}.log` }
    await writeFile(join(artifacts, `${proofName}.json`), `${JSON.stringify(proof, null, 2)}\n`)
    const stored = await readFile(join(artifacts, `${proofName}.log`), 'utf8')
    assert(!stored.includes('synthetic-eng028-browser-token'))
    process.stdout.write(`${JSON.stringify(proof)}\n`)
  } finally { await rm(root, { recursive: true, force: true }) }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
