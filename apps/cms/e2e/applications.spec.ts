import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

const jobID = '66666666-6666-4666-8666-666666666666'
const draftJobID = '99999999-9999-4999-8999-999999999999'
const expiredJobID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`
const resume = '%PDF-1.7\nSynthetic application resume\n%%EOF\n'
const longLinkedIn = `https://ca.linkedin.com/in/synthetic-applicant-${'profile-'.repeat(48)}end`

async function newPage(browser: Browser, role: 'owner' | 'hiring' | 'editor' | 'sales'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: `synthetic-application-${role}-session-token`, url: cmsOrigin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

test('ENG-021 accepts a valid multipart application only for a published role and protects its resume', async ({ browser, page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  const submit = async (targetJobID: string, idempotencyKey: string, coverLetter = 'I would like to apply for this synthetic role.', file = resume, telephone = '(416) 555-0199', profile = longLinkedIn) => page.evaluate(async ({ targetJobID, idempotencyKey, coverLetter, file, telephone, profile }) => {
    const form = new FormData()
    form.set('name', 'Synthetic Applicant')
    form.set('email', 'applicant.synthetic@example.test')
    form.set('telephone', telephone)
    form.set('linkedIn', profile)
    form.set('coverLetter', coverLetter)
    form.set('consent', 'true')
    form.set('jobId', targetJobID)
    form.set('idempotencyKey', idempotencyKey)
    form.set('resume', new File([file], 'synthetic-resume.pdf', { type: 'application/pdf' }))
    const response = await fetch('/api/applications', { method: 'POST', body: form })
    return { status: response.status, body: await response.json() as { id?: string; error?: string } }
  }, { targetJobID, idempotencyKey, coverLetter, file, telephone, profile })

  for (const [rejectedJobID, idempotencyKey] of [[draftJobID, '13131313-1313-4131-8131-131313131313'], [expiredJobID, '14141414-1414-4141-8141-141414141414'], ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '15151515-1515-4151-8151-151515151515']] as const) {
    const rejected = await submit(rejectedJobID, idempotencyKey)
    expect(rejected.status).toBe(400)
    expect(rejected.body).toEqual({ error: 'invalid_application' })
  }

  const created = await submit(jobID, '12121212-1212-4121-8121-121212121212')
  expect(created.status).toBe(201)
  expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/)
  const replay = await submit(jobID, '12121212-1212-4121-8121-121212121212')
  expect(replay).toEqual({ status: 200, body: { id: created.body.id } })
  const changedReplay = await submit(jobID, '12121212-1212-4121-8121-121212121212', 'A changed replay must never replace the stored application.')
  expect(changedReplay.status).toBe(400)
  expect(changedReplay.body).toEqual({ error: 'invalid_application' })
  expect((await submit(jobID, '12121212-1212-4121-8121-121212121212', undefined, undefined, '(647) 555-0100')).status).toBe(400)
  expect((await submit(jobID, '16161616-1616-4161-8161-161616161616', undefined, undefined, '123', longLinkedIn)).status).toBe(400)
  expect((await submit(jobID, '17171717-1717-4171-8171-171717171717', undefined, undefined, '(416) 555-0199', 'https://attacker.example/profile')).status).toBe(400)

  const resumeURL = `/api/applications/${created.body.id}/resume`
  const anonymous = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  expect((await anonymous.request.get(resumeURL)).status()).toBe(403)
  await anonymous.close()

  const owner = await newPage(browser, 'owner')
  const ownerResume = await owner.page.request.get(resumeURL)
  expect(ownerResume.status()).toBe(200)
  expect(ownerResume.headers()['content-type']).toBe('application/octet-stream')
  expect(ownerResume.headers()['content-disposition']).toContain('attachment; filename="resume"')
  expect(await ownerResume.body()).toEqual(Buffer.from(resume))
  const minted = await owner.page.request.post(`/api/hiring/applications/${created.body.id}/resume-link`, { headers: { origin: cmsOrigin } })
  expect(minted.status()).toBe(200)
  const signedURL = (await minted.json() as { url: string }).url
  expect((await owner.page.request.get(signedURL)).status()).toBe(200)
  expect((await owner.page.request.get(`${signedURL}x`)).status()).toBe(403)
  const expiredURL = (await (await owner.page.request.post(`/__e2e/applications/${created.body.id}/expired-link`)).json() as { url: string }).url
  expect((await owner.page.request.get(expiredURL)).status()).toBe(403)
  await owner.context.close()

  const hiring = await newPage(browser, 'hiring')
  expect((await hiring.page.request.get(resumeURL)).status()).toBe(200)
  expect((await hiring.page.request.get(signedURL)).status()).toBe(403)
  await hiring.context.close()

  for (const role of ['editor', 'sales'] as const) {
    const denied = await newPage(browser, role)
    expect((await denied.page.request.get(resumeURL)).status()).toBe(403)
    await denied.context.close()
  }
})

test('ENG-021 submits optional contact details through the public Astro form and keeps the protected intake immutable', async ({ browser, page }) => {
  test.setTimeout(90_000)
  await page.goto('/careers/synthetic-application-engineer')
  await expect(page.getByRole('heading', { name: 'Apply for this role' })).toBeVisible()
  await page.getByLabel('Name').fill('Browser Applicant')
  await page.getByLabel('Email').fill('browser.applicant@example.test')
  await page.getByLabel('Phone').fill('(647) 555-0123')
  await page.getByLabel('LinkedIn').fill(longLinkedIn)
  await page.getByLabel('Note (optional)').fill('I would like to apply through the public careers page.')
  await page.getByLabel(/Resume/).setInputFiles({ name: 'browser-resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from(resume) })
  await page.getByLabel(/I consent/).check()
  const submit = page.getByRole('button', { name: 'Submit application' })
  await submit.click()
  await expect(page.getByRole('status')).toHaveText('Your application has been received.')
  await expect(submit).toBeDisabled()

  const owner = await newPage(browser, 'owner')
  const read = async () => {
    const response = await owner.page.request.get('/api/hiring/applications?page=1')
    expect(response.status()).toBe(200)
    const application = (await response.json() as { docs: Array<{ id: string; email: string; telephone: string | null; linkedIn: string | null }> }).docs.find(item => item.email === 'browser.applicant@example.test')
    expect(application).toMatchObject({ telephone: '(647) 555-0123', linkedIn: longLinkedIn })
    return application!
  }
  const application = await read()
  const update = await owner.page.request.patch(`/api/applications/${application.id}`, { headers: { origin: cmsOrigin }, data: { telephone: '+1 000 000 0000', linkedIn: 'https://www.linkedin.com/in/replaced', status: 'reviewing' } })
  expect(update.status()).toBe(200)
  await read()
  await owner.context.close()
})

test('ENG-021 lets Owner and Hiring work the protected application dashboard while Sales and Editor are denied', async ({ browser }) => {
  test.setTimeout(90_000)
  for (const role of ['owner', 'hiring'] as const) {
    const session = await newPage(browser, role)
    await session.page.goto('/applications')
    await expect(session.page.getByRole('heading', { name: 'Careers' })).toBeAttached()
    await expect(session.page.getByRole('table', { name: 'Roles' })).toContainText('Synthetic Application Engineer')
    await expect(session.page.getByRole('table', { name: 'Roles' })).not.toContainText('Metadata job page')
    if (role === 'owner') await expect(session.page.getByRole('link', { name: 'Post a role' })).toBeVisible()
    else await expect(session.page.getByRole('link', { name: 'Post a role' })).toHaveCount(0)
    await session.page.getByRole('button', { name: /Applications ·/ }).click()
    await expect(session.page.getByRole('table', { name: 'Applications' })).toContainText('Synthetic Applicant')
    if (role === 'owner') { const listed = await session.page.request.get('/api/hiring/applications?page=1'); expect(listed.status()).toBe(200); const body = JSON.stringify(await listed.json()); expect(body).not.toContain('resumeKey'); expect(body).not.toContain('idempotencyKey') }
    await session.page.getByRole('button', { name: /Synthetic Applicant/ }).first().click()
    const details = session.page.getByRole('complementary', { name: 'Application details' })
    await expect(details).toContainText('Synthetic Application Engineer')
    await expect(details.getByRole('link', { name: '(416) 555-0199' })).toHaveAttribute('href', 'tel:4165550199')
    await expect(details.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', longLinkedIn)
    await expect(session.page.getByRole('button', { name: 'Download resume' })).toBeVisible()
    if (role === 'owner') { await details.getByRole('button', { name: 'Interview' }).click(); await expect(details.getByRole('button', { name: 'Interview' })).toHaveAttribute('aria-pressed', 'true'); await session.page.addScriptTag({ path: axeSource }); expect(await session.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]) }
    await session.context.close()
  }
  for (const role of ['editor', 'sales'] as const) {
    const session = await newPage(browser, role)
    expect((await session.page.request.get('/api/hiring/applications?page=1')).status()).toBe(403)
    expect((await session.page.request.get('/api/hiring/jobs')).status()).toBe(403)
    await session.page.goto('/applications')
    await expect(session.page.getByRole('alert').filter({ hasText: 'Unable to load Careers' })).toHaveText('Unable to load Careers. Check your connection or session.')
    await expect(session.page.getByRole('table', { name: 'Applications' })).toHaveCount(0)
    await expect(session.page.getByRole('link', { name: 'Post a role' })).toHaveCount(0)
    await session.context.close()
  }
})

test('ENG-021 starts a real job draft through the normal content editor and renders the designed Careers workspace at desktop and mobile', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  const owner = await newPage(browser, 'owner')
  await owner.page.setViewportSize({ width: 1440, height: 1050 })
  await owner.page.goto('/applications')
  await owner.page.getByRole('link', { name: 'Post a role' }).click()
  await expect(owner.page).toHaveURL(/\/content-editor\/new\?section=careers&template=job/)
  await expect(owner.page.getByLabel('Section')).toHaveValue(/.+/)
  await expect(owner.page.getByLabel('Section').locator('option:checked')).toHaveText('Careers')
  await expect(owner.page.getByLabel('Template')).toHaveValue('job')
  await owner.page.getByLabel('Title').fill('Synthetic Reviewed Careers Role')
  await owner.page.getByLabel('Summary').fill('A private synthetic role draft for the complete Careers workflow test.')
  await owner.page.getByRole('button', { name: 'Create draft' }).click()
  await expect(owner.page).toHaveURL(/\/content-editor\/[0-9a-f-]+$/)

  await owner.page.goto('/applications')
  await expect(owner.page.getByRole('table', { name: 'Roles' })).toContainText('Synthetic Reviewed Careers Role')
  await owner.page.screenshot({ path: testInfo.outputPath('careers-roles-1440.png'), fullPage: true })
  for (const width of [390, 320]) {
    await owner.page.setViewportSize({ width, height: 844 })
    expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const scroll = owner.page.getByLabel('Roles table, scroll horizontally for more columns', { exact: true }); await scroll.focus(); await scroll.press('End')
    await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth })
    await expect(owner.page.getByRole('link', { name: 'Edit role', exact: true }).first()).toBeInViewport()
    await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
    await owner.page.screenshot({ path: testInfo.outputPath(`careers-roles-${width}.png`), fullPage: true })
  }
  await owner.page.setViewportSize({ width: 1440, height: 1050 })
  await owner.page.getByRole('button', { name: /Applications ·/ }).click()
  await owner.page.getByRole('button', { name: /Synthetic candidate/ }).first().click()
  await expect(owner.page.getByRole('complementary', { name: 'Application details' }).getByText('Not provided')).toHaveCount(2)
  await owner.page.getByRole('button', { name: /Synthetic Applicant/ }).first().click()
  const desktopDetail = owner.page.getByRole('complementary', { name: 'Application details' })
  const desktopBox = await desktopDetail.boundingBox()
  expect(desktopBox?.width).toBeGreaterThanOrEqual(320)
  expect(desktopBox?.width).toBeLessThanOrEqual(360)
  await owner.page.addScriptTag({ path: axeSource })
  expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('careers-1440.png'), fullPage: true })

  await owner.page.setViewportSize({ width: 390, height: 844 })
  await expect(desktopDetail).toBeVisible()
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('careers-390.png'), fullPage: true })
  await owner.page.getByRole('button', { name: 'Closed · 0' }).click()
  await expect(owner.page.getByRole('status')).toContainText('No applications match these filters')
  expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('careers-empty-390.png'), fullPage: true })
  await owner.context.close()
})

test('ENG-021 rejects missing or hostile origins and an oversized multipart body before intake', async ({ browser }) => {
  const anonymous = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  const multipart = { name: 'Applicant', email: 'applicant@example.test', coverLetter: 'Synthetic security regression.', consent: 'true', jobId: jobID, idempotencyKey: '34343434-3434-4343-8343-343434343434', resume: { name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from(resume) } }
  expect((await anonymous.request.post('/api/applications', { multipart })).status()).toBe(403)
  expect((await anonymous.request.post('/api/applications', { headers: { origin: 'https://attacker.example' }, multipart })).status()).toBe(403)
  const oversized = { ...multipart, idempotencyKey: '56565656-5656-4565-8565-565656565656', resume: { name: 'large.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(6 * 1024 * 1024)]) } }
  expect((await anonymous.request.post('/api/applications', { headers: { origin: cmsOrigin }, multipart: oversized })).status()).toBe(413)
  await anonymous.close()
})

test('ENG-021 persists private hiring notes and retains them beyond unrelated audit activity', async ({ browser }) => {
  const owner = await newPage(browser, 'owner')
  await owner.page.goto('/applications')
  await owner.page.getByRole('button', { name: /Applications ·/ }).click()
  await owner.page.getByRole('button', { name: /Synthetic Applicant/ }).first().click()
  await owner.page.getByLabel('Add note').fill('Private hiring note retained for this application.')
  await owner.page.getByRole('button', { name: 'Save note' }).click()
  await expect(owner.page.getByRole('complementary', { name: 'Application details' })).toContainText('Private hiring note retained for this application.')
  const listed = await owner.page.request.get('/api/applications?limit=1&page=1&where[email][equals]=applicant.synthetic@example.test')
  expect(listed.status()).toBe(200)
  const application = (await listed.json() as { docs: Array<{ id: string }> }).docs[0]!
  expect((await owner.page.request.post('/__e2e/audit-noise')).status()).toBe(204)
  const history = await owner.page.request.get(`/api/hiring/applications/${application.id}/history`)
  expect(history.status()).toBe(200)
  expect(JSON.stringify(await history.json())).toContain('Private hiring note retained for this application.')
  await owner.page.reload(); await owner.page.getByRole('button', { name: /Applications ·/ }).click(); await owner.page.getByRole('button', { name: /Synthetic Applicant/ }).first().click()
  await expect(owner.page.getByRole('complementary', { name: 'Application details' })).toContainText('Private hiring note retained for this application.')
  await owner.context.close()
  const hiring = await newPage(browser, 'hiring')
  const visible = await hiring.page.request.get(`/api/hiring/applications/${application.id}/history`)
  expect(visible.status()).toBe(200)
  expect(JSON.stringify(await visible.json())).toContain('Private hiring note retained for this application.')
  await hiring.context.close()
  for (const role of ['editor', 'sales'] as const) { const denied = await newPage(browser, role); expect((await denied.page.request.get(`/api/hiring/applications/${application.id}/history`)).status()).toBe(403); await denied.context.close() }
})

test('ENG-021 invalidates an already minted resume link when its Owner session role is revoked', async ({ browser }) => {
  const owner = await newPage(browser, 'owner')
  const listed = await owner.page.request.get('/api/applications?limit=1&page=1')
  const application = (await listed.json() as { docs: Array<{ id: string }> }).docs[0]!
  const minted = await owner.page.request.post(`/api/hiring/applications/${application.id}/resume-link`, { headers: { origin: cmsOrigin } })
  const url = (await minted.json() as { url: string }).url
  expect((await owner.page.request.get(url)).status()).toBe(200)
  expect((await owner.page.request.post('/__e2e/application-owner/disable')).status()).toBe(204)
  expect((await owner.page.request.get(url)).status()).toBe(403)
  await owner.context.close()
})
