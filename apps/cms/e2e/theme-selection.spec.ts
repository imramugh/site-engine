import { expect, test } from '@playwright/test'

const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`
const manifest = { name: 'browser-theme', version: '2.4.6', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'faq'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } }

test('ENG-035 owner proposes an installed theme through browser HTTP and freezes it in the preview candidate', async ({ page }) => {
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('theme-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill('synthetic-theme-owner-code-08')
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  const result = await page.evaluate(async ({ manifest }) => {
    const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value)
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(manifest)))
    const manifestDigest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const selection = { id: manifest.name, version: manifest.version, contract: manifest.contract, manifestDigest }
    const created = await fetch('/api/theme-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selection, settings: { [manifest.name]: { tone: 'warm' } } }) })
    const createdBody = await created.json() as { doc?: unknown }
    const listed = await fetch('/api/editorial/list', { cache: 'no-store' })
    const sets = await listed.json() as { sets: Array<{ id: string; state: string; changes: Array<{ collection: string; id: string }> }> }
    const set = sets.sets.find((candidate) => candidate.state === 'open' && candidate.changes.some((change) => change.collection === 'theme-settings'))!
    const submitted = await fetch('/api/editorial/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id }) })
    const submittedBody = await submitted.json() as { revision?: number; changes?: Array<{ collection: string; id: string }> }
    const includedChangeKeys = submittedBody.changes!.filter((change) => change.collection === 'theme-settings').map((change) => `${change.collection}:${change.id}`)
    const prepared = await fetch('/api/editorial/prepare-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id, includedChangeKeys }) })
    return { created: created.status, createdBody, submitted: submitted.status, prepared: prepared.status, job: await prepared.json() as { job?: { proposedManifest?: { settings?: { theme?: unknown } } } }, selection }
  }, { manifest })
  expect(result.created).toBe(201)
  expect(result.submitted).toBe(200)
  expect(result.prepared).toBe(200)
  expect(result.job.job?.proposedManifest?.settings?.theme).toEqual(result.selection)
  expect(await page.request.get(`${cmsOrigin}/__e2e/publish-state`).then(async (response) => response.json())).toMatchObject({ releaseCount: 1 })
})
