import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({
    name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const,
  })))
  return { context, page: await context.newPage() }
}

async function assertNoAxeViolations(page: Page) {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
}

test('ENG-006/ENG-026 creates a validated private page and reopens its saved draft without publishing', async ({ browser }) => {
  test.setTimeout(90_000)
  const owner = await signedIn(browser, 'synthetic-page-creator-owner-session-token')
  const before = await owner.page.request.get('/__e2e/publish-state').then((response) => response.json()) as { releaseCount: number }
  await owner.page.goto('/content-tree')
  await owner.page.getByRole('link', { name: '+ New page', exact: true }).click()
  await expect(owner.page).toHaveURL('/content-editor/new')
  await expect(owner.page.locator('[data-admin-page-title]')).toHaveText('Create page')
  await expect(owner.page.locator('[data-admin-primary] [href="/content-tree"]')).toHaveAttribute('aria-current', 'page')

  await owner.page.getByLabel('Title').fill('Created browser landing')
  await expect(owner.page.getByLabel('URL segment')).toHaveValue('created-browser-landing')
  await owner.page.getByLabel('Summary').fill('Too short')
  await owner.page.getByLabel('Section', { exact: true }).selectOption({ label: 'Direct edit browser section' })
  await owner.page.getByLabel('Template', { exact: true }).selectOption('landing')
  await owner.page.getByRole('button', { name: 'Create draft' }).click()
  await expect(owner.page).toHaveURL('/content-editor/new')
  expect(await owner.page.getByLabel('Summary').evaluate((field: HTMLTextAreaElement) => field.validity.tooShort)).toBe(true)

  const summary = 'A private browser-created landing page that remains inside the editorial review workflow.'
  await owner.page.getByLabel('Summary').fill(summary)
  let creationBody: Record<string, unknown> | undefined
  owner.page.on('request', (request) => {
    if (request.url().endsWith('/api/editorial/page-editor/create') && request.method() === 'POST') creationBody = request.postDataJSON() as Record<string, unknown>
  })
  const createdResponse = owner.page.waitForResponse((response) => response.url().endsWith('/api/editorial/page-editor/create') && response.status() === 201)
  await owner.page.getByRole('button', { name: 'Create draft' }).click()
  expect((await createdResponse).status()).toBe(201)
  await expect(owner.page).toHaveURL(/\/content-editor\/[0-9a-f-]{36}$/)
  const pageID = new URL(owner.page.url()).pathname.split('/').at(-1)!
  expect(creationBody).toMatchObject({ title: 'Created browser landing', summary, template: 'landing' })
  await expect(owner.page.locator('[data-page-state]')).toContainText('Create Created browser landing · 1 changes')
  const hero = owner.page.locator('[data-page-editor-block]').first()
  await hero.locator('summary').click()
  await expect(hero.getByLabel('Heading', { exact: true })).toHaveValue('Created browser landing')
  await expect(hero.getByRole('textbox', { name: 'Body', exact: true })).toHaveValue(summary)

  await owner.page.getByText('Page fields', { exact: false }).first().click()
  await owner.page.getByLabel('Title', { exact: true }).fill('Created browser landing revised')
  const savedResponse = owner.page.waitForResponse((response) => response.url().endsWith(`/api/editorial/page-editor/${pageID}`) && response.request().method() === 'POST' && response.status() === 200)
  await owner.page.getByRole('button', { name: 'Save draft' }).click()
  await savedResponse
  await owner.page.reload()
  await expect(owner.page.getByLabel('Title', { exact: true })).toHaveValue('Created browser landing revised')

  const replay = await owner.page.request.post('/api/editorial/page-editor/create', { headers: { origin, 'content-type': 'application/json' }, data: creationBody })
  expect(replay.status(), await replay.text()).toBe(200)
  expect(await replay.json()).toMatchObject({ pageID, changeSetID: expect.any(String), replayed: true })
  const deniedOrigin = await owner.page.request.post('/api/editorial/page-editor/create', { headers: { origin: 'https://hostile.example', 'content-type': 'application/json' }, data: { ...creationBody, requestKey: crypto.randomUUID() } })
  expect(deniedOrigin.status()).toBe(403)
  const after = await owner.page.request.get('/__e2e/publish-state').then((response) => response.json()) as { releaseCount: number }
  expect(after.releaseCount).toBe(before.releaseCount)

  await owner.page.setViewportSize({ width: 390, height: 844 })
  await owner.page.goto('/content-editor/new')
  expect(await owner.page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await assertNoAxeViolations(owner.page)
  await owner.context.close()
})

test('ENG-006 permits page creation only to Owner and Editor roles', async ({ browser }) => {
  const hiring = await signedIn(browser, 'synthetic-application-hiring-session-token')
  await hiring.page.goto('/content-editor/new')
  await expect(hiring.page).toHaveURL(/\/admin\/login/)
  const response = await hiring.page.request.post('/api/editorial/page-editor/create', { headers: { origin, 'content-type': 'application/json' }, data: { requestKey: crypto.randomUUID(), title: 'Denied', summary: 'This request is long enough but must be rejected by role.', slug: 'denied', sectionID: 'ffffffff-ffff-4fff-8fff-ffffffffffff', template: 'standard' } })
  expect(response.status()).toBe(403)
  await hiring.context.close()
})
