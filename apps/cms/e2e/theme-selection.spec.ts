import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`

async function signedInOwner(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-theme-owner-session-token', url: cmsOrigin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function rolePage(browser: Browser, role: 'editor' | 'sales'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: `synthetic-application-${role}-session-token`, url: cmsOrigin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function openAdminNavigation(page: Page): Promise<void> {
  const menu = page.getByTestId('mobile-menu')
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'false') await menu.click()
}

test('ENG-035 lets an Owner choose a compatible installed theme into a named reviewed change set', async ({ browser }) => {
  const owner = await signedInOwner(browser)
  await owner.page.goto('/admin')
  await openAdminNavigation(owner.page)
  await owner.page.getByText('More tools', { exact: true }).click()
  await expect(owner.page.getByRole('link', { name: 'Themes' })).toBeVisible()
  await owner.page.getByRole('link', { name: 'Themes' }).click()
  await expect(owner.page).toHaveURL(/\/themes$/)
  await expect(owner.page.getByRole('heading', { name: 'Themes' })).toBeVisible()
  await expect(owner.page.getByLabel('Current theme selections')).toContainText('Published: None selected')
  await owner.page.getByLabel('Theme', { exact: true }).selectOption({ label: 'browser-theme 2.4.6' })
  await expect(owner.page.getByLabel('Theme compatibility')).toContainText('Compatible with the current published content.')
  await owner.page.getByLabel('Change set name').fill('Switch synthetic browser theme')
  const created = owner.page.waitForResponse((response) => response.url().endsWith('/api/themes') && response.request().method() === 'POST')
  await owner.page.getByRole('button', { name: 'Create draft selection' }).click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(201)
  const createdBody = await createdResponse.json() as { changeSet: { id: string; name: string }; selection: { id: string; version: string } }
  expect(createdBody).toMatchObject({ changeSet: { name: 'Switch synthetic browser theme' }, selection: { id: 'browser-theme', version: '2.4.6' } })
  await expect(owner.page.getByRole('status')).toContainText('Draft theme selection captured')
  await expect(owner.page.getByLabel('Current theme selections')).toContainText('Draft: browser-theme 2.4.6')

  const lifecycle = await owner.page.evaluate(async (id) => {
    const submitted = await fetch('/api/editorial/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    const submittedBody = await submitted.json() as { changes?: Array<{ collection: string; id: string }> }
    const includedChangeKeys = submittedBody.changes?.filter((change) => change.collection === 'theme-settings').map((change) => `${change.collection}:${change.id}`) ?? []
    const prepared = await fetch('/api/editorial/prepare-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, includedChangeKeys }) })
    return { submitted: submitted.status, submittedBody, prepared: prepared.status, job: await prepared.json() as { job?: { proposedManifest?: { settings?: { theme?: unknown } } } } }
  }, createdBody.changeSet.id)
  expect(lifecycle.submitted, JSON.stringify(lifecycle.submittedBody)).toBe(200)
  expect(lifecycle.prepared).toBe(200)
  expect(lifecycle.job.job?.proposedManifest?.settings?.theme).toMatchObject({ id: 'browser-theme', version: '2.4.6' })
  expect(await owner.page.request.get(`${cmsOrigin}/__e2e/publish-state`).then(async (response) => response.json())).toMatchObject({ releaseCount: 1 })
  await owner.page.addScriptTag({ path: axeSource })
  expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.context.close()
})

test('ENG-035 reports incompatibility and limits theme selection to installed owner-only metadata', async ({ browser }) => {
  const owner = await signedInOwner(browser)
  const metadata = await owner.page.request.get('/api/themes')
  expect(metadata.status()).toBe(200)
  const body = await metadata.json() as { themes: Array<{ id: string; manifestDigest: string; compatibility: { compatible: boolean } }> }
  expect(body.themes.find((theme) => theme.id === 'browser-theme')?.compatibility.compatible).toBe(true)
  expect(body.themes.find((theme) => theme.id === 'browser-theme')?.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(body.themes.find((theme) => theme.id === 'incomplete-browser-theme')?.compatibility.compatible).toBe(false)
  expect(JSON.stringify(body)).not.toContain('./dist/')
  await owner.page.goto('/themes')
  await owner.page.getByLabel('Theme', { exact: true }).selectOption({ label: 'incomplete-browser-theme 1.0.0' })
  await expect(owner.page.getByLabel('Theme compatibility')).toContainText('This theme cannot render the current published content.')
  await expect(owner.page.getByRole('button', { name: 'Create draft selection' })).toBeDisabled()
  const hostile = await owner.page.request.post('/api/themes', { headers: { origin: cmsOrigin, 'content-type': 'application/json' }, data: { id: '<img src=x onerror=alert(1)>', version: '1.0.0', changeSetName: '<script>alert(1)</script>' } })
  expect(hostile.status()).toBe(400)
  expect(JSON.stringify(await hostile.json())).not.toContain('<script>')
  await owner.context.close()
})

test('ENG-035 denies non-Owners and rejects cross-origin theme selection requests', async ({ browser }) => {
  for (const role of ['editor', 'sales'] as const) {
    const denied = await rolePage(browser, role)
    expect((await denied.page.request.get('/api/themes')).status()).toBe(403)
    await denied.page.goto('/themes')
    await expect(denied.page.getByRole('status')).toContainText('Owner access is required')
    await denied.context.close()
  }
  const owner = await signedInOwner(browser)
  const csrf = await owner.page.request.post('/api/themes', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: { id: 'browser-theme', version: '2.4.6', changeSetName: 'Blocked cross-origin selection' } })
  expect(csrf.status()).toBe(403)
  await owner.context.close()
})
