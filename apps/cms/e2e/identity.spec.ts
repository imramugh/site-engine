import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

const ownerInvite = 'synthetic-browser-owner-invite'
const reviewOwnerEmail = 'review-owner.synthetic@example.test'
const reviewOwnerRecoveryCode = 'synthetic-review-owner-code-04'
const scheduleOwnerEmail = 'schedule-owner.synthetic@example.test'
const scheduleOwnerRecoveryCode = 'synthetic-schedule-owner-code-09'
const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`
const issuerOrigin = `https://127.0.0.1:${e2ePort + 1}`

async function signIn(page: Page, identity: 'owner' | 'editor', invite?: string): Promise<string> {
  const start = page.waitForResponse((response) => response.url().startsWith(`${cmsOrigin}/api/auth/google`) && response.status() === 307)
  const callback = page.waitForRequest((request) => request.url().startsWith(`${cmsOrigin}/api/auth/callback/google?`))
  await page.goto(invite ? `/api/auth/google?invite=${invite}` : '/api/auth/google')
  expect((await start).headers()['critical-ch']).toBeUndefined()
  await page.getByRole('button', { name: identity === 'owner' ? 'Sign in as Synthetic Owner' : 'Sign in as Synthetic Editor' }).click()
  const callbackURL = (await callback).url()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  return callbackURL
}

async function signInLocalOwner(page: Page, recoveryCode = 'synthetic-local-recovery-code-02', email = 'emergency-owner.synthetic@example.test'): Promise<void> {
  const providerRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(`${issuerOrigin}/`)) providerRequests.push(request.url())
  })
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill(email)
  await page.locator('#emergency-code').fill(recoveryCode)
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  expect(providerRequests).toEqual([])
}

test('an invited Google identity creates an owner session and loads admin', async ({ page }) => {
  await signIn(page, 'owner', ownerInvite)
  await expect(page).not.toHaveURL(/\/admin\/login/)
  await expect(page.locator('body')).not.toContainText('Synthetic identity provider')
  const workspaceNavigation = page.getByRole('navigation', { name: 'Workspace' })
  await expect(workspaceNavigation.getByRole('link', { name: 'Content', exact: true })).toBeVisible()
  await expect(workspaceNavigation.getByRole('link', { name: 'Reviews', exact: true })).toBeVisible()
  await expect(page.locator('[data-admin-page-title]')).toHaveText('Dashboard')
  expect(await page.locator('html').evaluate((element) => getComputedStyle(element).getPropertyValue('--theme-elevation-0').trim())).not.toBe('')
  const session = (await page.context().cookies()).find((cookie) => cookie.name === '__Host-site_engine_session')
  expect(session).toMatchObject({ secure: true, httpOnly: true, path: '/', sameSite: 'Lax' })
  await page.screenshot({ path: 'artifacts/playwright-cms/owner-admin.png', fullPage: true })
  const response = await page.request.get('/api/users/me')
  expect(response.ok()).toBeTruthy()
  const body = await response.text()
  expect(body).toContain('owner.synthetic@example.test')
  expect(body).not.toContain('synthetic-browser-secret')
  expect(body).not.toContain('synthetic-browser-payload-secret-not-for-production')
  const section = await page.evaluate(async () => {
    const response = await fetch('/api/sections', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'Browser services',
      summary: 'This synthetic section proves browser callers receive field-specific content tree validation errors.',
      slug: 'browser-services',
      allowedTemplates: ['landing', 'pillar', 'service'],
      }),
    })
    return { status: response.status, body: await response.json() as { doc: { id: string } } }
  })
  expect(section.status).toBe(201)
  const invalidPage = await page.evaluate(async (sectionID) => {
    const response = await fetch('/api/pages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: 'Invalid browser article',
      summary: 'This synthetic browser request chooses a template the selected section does not permit.',
      slug: 'invalid-browser-article',
      sectionId: sectionID,
      template: 'article',
      blocks: [],
      }),
    })
    return { status: response.status, body: await response.json() as { errors: Array<{ data?: { errors?: Array<{ path: string; message: string }> } }> } }
  }, section.body.doc.id)
  expect(invalidPage.status).toBe(400)
  expect(invalidPage.body.errors[0]?.data?.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'template', message: expect.stringContaining('not allowed') }),
  ]))
  const deletion = await page.evaluate(async (sectionID) => (await fetch(`/api/sections/${sectionID}`, { method: 'DELETE' })).status, section.body.doc.id)
  expect(deletion).toBeGreaterThanOrEqual(400)
  const configured = await page.evaluate(async () => {
    const response = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', provider: 'google-gemini', model: 'synthetic-browser-model', credential: 'synthetic-browser-provider-credential', fallbackProvider: null, monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test/browser', pricingAsOf: '2026-10-04' }) })
    return response.status
  })
  expect(configured).toBe(201)
  await page.goto('/ai-jobs')
  await page.locator('#ai-provider').selectOption('google-gemini')
  await expect(page.getByRole('heading', { name: 'AI generation' })).toBeVisible()
  await page.locator('#ai-prompt').fill('Synthetic browser prompt that must not be shown in the job listing.')
  await page.locator('#ai-max-output').fill('32')
  await page.getByRole('button', { name: 'Queue generation' }).click()
  await expect(page.getByRole('status')).toContainText('Generation queued')
  await expect(page.getByLabel('AI jobs')).not.toContainText('Synthetic browser prompt')
})

test('an editor can read only its own profile and anonymous REST stays denied', async ({ browser, page }) => {
  const anonymous = await browser.newContext()
  const anonymousResponse = await anonymous.request.get(`${cmsOrigin}/api/users`)
  expect(anonymousResponse.status()).toBeGreaterThanOrEqual(400)
  expect(await anonymousResponse.text()).not.toContain('owner.synthetic@example.test')
  await anonymous.close()

  await signIn(page, 'editor')
  const me = await page.request.get('/api/users/me')
  expect(me.ok()).toBeTruthy()
  expect(await me.text()).toContain('editor.synthetic@example.test')
  const users = await page.request.get('/api/users?limit=20')
  expect(users.ok()).toBeTruthy()
  const usersBody = await users.text()
  expect(usersBody).toContain('editor.synthetic@example.test')
  expect(usersBody).not.toContain('owner.synthetic@example.test')
  expect(usersBody).not.toContain('synthetic-browser-secret')
  expect(usersBody).not.toContain('synthetic-encrypted-secret-sentinel')
  expect(usersBody).not.toContain('synthetic-recovery-hash-sentinel')
  await page.goto('/admin')
  const adminHTML = await page.content()
  expect(adminHTML).not.toContain('synthetic-encrypted-secret-sentinel')
  expect(adminHTML).not.toContain('synthetic-recovery-hash-sentinel')
})

test('ENG-002 rejects an editor draft block with an undeclared appearance value without changing the draft', async ({ page }) => {
  await signIn(page, 'editor')
  await page.goto('/block-gallery')
  await expect(page.getByRole('heading', { name: 'Block gallery' })).toBeVisible()
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])

  const isolatedSet = await page.evaluate(async () => {
    const response = await fetch('/api/editorial/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `ENG-002 appearance validation ${crypto.randomUUID()}` }) })
    return { status: response.status, set: await response.json() as { id?: string } }
  })
  expect(isolatedSet.status).toBe(200)
  expect(isolatedSet.set.id).toMatch(/^[a-f0-9-]{36}$/)

  const result = await page.evaluate(async (changeSetID) => {
    const headers = { 'content-type': 'application/json', 'x-site-engine-change-set': changeSetID }
    const sectionResponse = await fetch('/api/sections', {
      method: 'POST', headers, body: JSON.stringify({
        name: 'Appearance browser validation',
        summary: 'A synthetic section for browser-level contract validation.',
        slug: 'appearance-browser-validation',
        allowedTemplates: ['standard'],
      }),
    })
    const section = await sectionResponse.json() as { doc?: { id: string } }
    if (!section.doc) return { sectionStatus: sectionResponse.status, section }
    const validBlock = {
      id: crypto.randomUUID(), type: 'hero', heading: 'Valid browser appearance', body: 'This neutral block is the unchanged draft baseline.', hidden: false,
      appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' },
    }
    const createdResponse = await fetch('/api/pages', {
      method: 'POST', headers, body: JSON.stringify({
        title: 'Appearance validation draft', summary: 'A synthetic page for browser-level appearance validation.', slug: 'appearance-validation-draft', sectionId: section.doc.id, template: 'standard', blocks: [validBlock],
      }),
    })
    const created = await createdResponse.json() as { doc?: { id: string; blocks: unknown[] } }
    if (!created.doc) return { sectionStatus: sectionResponse.status, createdStatus: createdResponse.status, section, created }
    const rejectedResponse = await fetch(`/api/pages/${created.doc.id}?draft=true`, {
      method: 'PATCH', headers, body: JSON.stringify({
        blocks: [{ ...validBlock, appearance: { ...validBlock.appearance, background: 'rawCSS' } }],
      }),
    })
    const rejected = await rejectedResponse.json() as { errors?: Array<{ data?: { errors?: Array<{ path?: string; message?: string }> } }> }
    const afterResponse = await fetch(`/api/pages/${created.doc.id}?draft=true`)
    const after = await afterResponse.json() as { blocks?: unknown[] }
    return { sectionStatus: sectionResponse.status, createdStatus: createdResponse.status, rejectedStatus: rejectedResponse.status, afterStatus: afterResponse.status, rejected, beforeBlocks: created.doc.blocks, afterBlocks: after.blocks, sectionID: section.doc.id, pageID: created.doc.id }
  }, isolatedSet.set.id!)

  expect(result.sectionStatus).toBe(201)
  expect(result.createdStatus).toBe(201)
  expect(result.rejectedStatus).toBe(400)
  expect(result.rejected?.errors?.flatMap((error) => error.data?.errors ?? [])).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'blocks.0.appearance.background' }),
  ]))
  expect(result.afterStatus).toBe(200)
  expect(result.afterBlocks).toEqual(result.beforeBlocks)

  const cleanup = await page.evaluate(async ({ changeSetID, pageID, sectionID }) => {
    const listed = await fetch('/api/editorial/list', { cache: 'no-store' })
    const list = await listed.json() as { sets?: Array<{ id: string; state: string; changes?: Array<{ collection: string; id: string }> }> }
    const matching = list.sets?.filter((set) => set.id === changeSetID && set.state === 'open' && set.changes?.some((change) => change.collection === 'pages' && change.id === pageID) && set.changes?.some((change) => change.collection === 'sections' && change.id === sectionID)) ?? []
    if (matching.length !== 1) return { listed: listed.status, matching: matching.length }
    const discarded = await fetch('/api/editorial/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: matching[0].id }) })
    return { listed: listed.status, matching: matching.length, discarded: discarded.status }
  }, { changeSetID: isolatedSet.set.id!, pageID: result.pageID, sectionID: result.sectionID })
  expect(cleanup).toEqual({ listed: 200, matching: 1, discarded: 200 })
})


async function selectCapturedSet(page: import('@playwright/test').Page, pageID: string) {
  const response = await page.request.get('/api/editorial/list')
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { sets: Array<{ id: string; state: string; changes?: Array<{ id: string; collection: string }> }> }
  const set = data.sets.find(item => item.state === 'open' && item.changes?.some(change => change.collection === 'pages' && change.id === pageID))
  expect(set, 'The created page must have its own captured open change set').toBeTruthy()
  await page.locator(`[data-change-set-id="${set!.id}"]`).click()
  return set!.id
}


test('editorial UI shows field diffs and routes review actions through CSRF-protected lifecycle endpoints', async ({ browser, page }) => {
  test.setTimeout(60_000)
  await signIn(page, 'editor')
  const created = await page.evaluate(async () => {
    const section = await fetch('/api/sections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Workflow', summary: 'This synthetic section supports the editorial browser workflow acceptance test.', slug: 'workflow-browser', allowedTemplates: ['standard'] }) })
    const sectionBody = await section.json() as { doc: { id: string } }
    const pageResponse = await fetch('/api/pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Workflow original', summary: 'This synthetic draft is changed through the browser before review is requested.', slug: 'workflow-page', sectionId: sectionBody.doc.id, template: 'standard' }) })
    const pageBody = await pageResponse.json() as { doc: { id: string } }
    await fetch(`/api/pages/${pageBody.doc.id}?draft=true`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Workflow revised' }) })
    return pageBody.doc.id
  })
  await page.goto('/admin/editorial')
  await expect(page.locator('[data-admin-page-title]')).toHaveText('Reviews')

  const changeSetID = await selectCapturedSet(page, created)

  await expect(page.getByText('Title', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Submitted' })).toContainText('Submitted')
  const editorQuality = await page.evaluate(async () => (await fetch('/api/editorial/run-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: document.querySelector('button[aria-pressed="true"]')?.textContent?.split(' — ')[0] }) })).status)
  expect(editorQuality).toBe(403)
  const directSpoof = await page.evaluate(async () => (await fetch('/api/change-sets/not-a-real-id', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'approved' }) })).status)
  expect(directSpoof).toBeGreaterThanOrEqual(400)

  const reviewerContext = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  const reviewer = await reviewerContext.newPage()
  // This test is intentionally runnable on its own. The invitation-backed
  // synthetic owner belongs to the enrollment test, so use an e2e-only local
  // owner whose revocation cannot affect the other identity journeys.
  await signInLocalOwner(reviewer, reviewOwnerRecoveryCode, reviewOwnerEmail)
  await reviewer.goto('/admin/editorial')
  await reviewer.clock.install({ time: new Date('2030-01-01T00:00:00.000Z') })
  await reviewer.addScriptTag({ path: axeSource })
  expect(await reviewer.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  const submittedQueueItem = reviewer.locator(`[data-editorial-queue-item][data-change-set-id="${changeSetID}"]`)
  await expect(submittedQueueItem).toContainText('revision')
  await expect(submittedQueueItem.locator('[data-editorial-state="submitted"]')).toHaveText('submitted')
  await submittedQueueItem.click()
  await expect(reviewer.locator('[data-editorial-detail] [data-editorial-state="submitted"]')).toHaveText('submitted')
  await expect(reviewer.getByLabel(/Include pages/)).toBeChecked()
  await reviewer.getByRole('button', { name: 'Prepare comparison' }).click()
  await expect(reviewer.getByRole('main').getByRole('status')).toContainText('Private comparison queued')
  const workerHeaders = { authorization: 'Bearer synthetic-preview-worker-token-long-enough-for-browser-tests', 'content-type': 'application/json' }
  const claimed = await reviewer.request.post('/api/internal/preview-jobs/claim', { headers: workerHeaders, data: {} })
  expect(claimed.ok(), await claimed.text()).toBeTruthy()
  const claim = await claimed.json() as { job: { id: string; leaseToken: string }; live: unknown; proposed: unknown }
  const hash = async (value: unknown) => await reviewer.evaluate(async (input) => {
    const stable = (item: unknown): string => Array.isArray(item) ? `[${item.map(stable).join(',')}]` : item && typeof item === 'object' ? `{${Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}` : JSON.stringify(item)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(input)))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }, value)
  const completed = await reviewer.request.post('/api/internal/preview-jobs/complete', { headers: workerHeaders, data: { id: claim.job.id, leaseToken: claim.job.leaseToken, liveManifestHash: await hash(claim.live), proposedManifestHash: await hash(claim.proposed), artifactDigest: 'b'.repeat(64) } })
  expect(completed.ok(), await completed.text()).toBeTruthy()
  await expect(reviewer.getByRole('status').filter({ hasText: 'Private comparison is ready for review.' })).toContainText('ready for review')
  await expect(reviewer.getByTitle('Live comparison')).toBeVisible({ timeout: 10_000 })
  await expect(reviewer.getByTitle('Proposed comparison')).toBeVisible()
  await expect(reviewer.getByTitle('Proposed comparison')).toHaveAttribute('src', /\/workflow-browser\/workflow-page$/)
  const proposedPreview = reviewer.getByRole('link', { name: 'Review on page' })
  await expect(proposedPreview).toHaveAttribute('href', `/review/${changeSetID}`)
  await expect(reviewer.getByText('Open the protected rendered page with block navigation and review actions.')).toBeVisible()
  await expect(reviewer.locator('[data-editorial-change-rail]')).toContainText('Changes')
  await reviewer.setViewportSize({ width: 1440, height: 1000 })
  const desktopFrames = reviewer.locator('[data-editorial-frame]')
  const liveBox = (await desktopFrames.nth(0).boundingBox())!
  const proposedBox = (await desktopFrames.nth(1).boundingBox())!
  expect(liveBox.x).not.toBe(proposedBox.x)
  expect(liveBox.y).toBe(proposedBox.y)
  const previewViewport = (title: string) => reviewer.getByTitle(title).evaluate((frame: HTMLIFrameElement) => ({ width: frame.contentWindow?.innerWidth, height: frame.contentWindow?.innerHeight }))
  await expect.poll(() => previewViewport('Live comparison')).toEqual({ width: 760, height: 640 })
  const assertReviewAccessibility = async () => {
    expect(await reviewer.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  }
  await assertReviewAccessibility()
  await reviewer.evaluate(() => window.scrollTo(0, 0))
  await reviewer.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await reviewer.screenshot({ path: 'artifacts/editorial-comparison-1440.png', fullPage: true })
  await reviewer.getByRole('button', { name: 'Live', exact: true }).click()
  await expect(reviewer.getByTitle('Proposed comparison')).toHaveCount(0)
  const singlePane = reviewer.locator('[data-editorial-frame]')
  const panes = reviewer.locator('[data-editorial-frames]')
  expect((await singlePane.boundingBox())!.width).toBeGreaterThan((await panes.boundingBox())!.width - 30)
  await reviewer.getByRole('button', { name: 'Proposed', exact: true }).click()
  await expect(reviewer.getByTitle('Live comparison')).toHaveCount(0)
  await reviewer.getByRole('button', { name: 'Side by side' }).click()
  await reviewer.getByRole('button', { name: 'Mobile', exact: true }).click()
  await expect.poll(() => previewViewport('Live comparison')).toEqual({ width: 390, height: 640 })
  await reviewer.setViewportSize({ width: 390, height: 844 })
  const mobileFrames = reviewer.locator('[data-editorial-frame]')
  expect((await mobileFrames.nth(0).boundingBox())!.y).not.toBe((await mobileFrames.nth(1).boundingBox())!.y)
  expect(await reviewer.locator('main').evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await assertReviewAccessibility()
  await reviewer.evaluate(() => window.scrollTo(0, 0))
  await reviewer.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await reviewer.screenshot({ path: 'artifacts/editorial-comparison-390.png', fullPage: true })
  await reviewer.getByRole('button', { name: 'Desktop', exact: true }).click()
  await expect.poll(() => previewViewport('Proposed comparison')).toEqual({ width: 760, height: 640 })
  let commentAttempts = 0
  await reviewer.route('**/api/editorial/comment', async (route) => { commentAttempts += 1; if (commentAttempts === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); return route.continue() })
  const comment = reviewer.getByLabel('Add review comment'); await comment.fill('Retry-safe browser comment'); await reviewer.getByRole('button', { name: 'Add comment' }).click()
  await expect(reviewer.getByRole('status').filter({ hasText: 'Unable to add this comment' })).toContainText('Unable to add this comment'); await expect(comment).toHaveValue('Retry-safe browser comment')
  await reviewer.getByRole('button', { name: 'Add comment' }).click(); await expect(comment).toHaveValue('')
  await expect(reviewer.getByText('Approval requires a passing readiness proof for this exact comparison.')).toBeVisible()
  await reviewer.getByRole('button', { name: 'Run readiness checks' }).click()
  await expect(reviewer.getByRole('status').filter({ hasText: 'Deterministic readiness checks completed' })).toContainText('completed')
  await expect(reviewer.getByText(/SEO_DESCRIPTION_MISSING/).first()).toBeVisible()
  await expect(reviewer.getByRole('button', { name: 'Approve and queue publish' })).toBeVisible()
  const displayed = await reviewer.evaluate(async (id) => {
    const response = await fetch('/api/editorial/list', { cache: 'no-store' })
    const body = await response.json() as { sets: Array<{ id: string; quality?: { proof?: Record<string, unknown> } }> }
    const set = body.sets.find((item) => item.id === id)!
    return { id: set.id, proof: set.quality?.proof! }
  }, changeSetID)
  const beforeApproval = await (await reviewer.request.get('/__e2e/publish-state')).json()
  const staleProof = await reviewer.evaluate(async ({ id, proof }) => (await fetch('/api/editorial/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, proof: { ...proof, previewJobID: '00000000-0000-4000-8000-000000000000' } }) })).status, displayed)
  expect(staleProof).toBe(400)
  await expect(reviewer.request.get('/__e2e/publish-state').then(async (response) => response.json())).resolves.toEqual(beforeApproval)
  await reviewer.getByRole('button', { name: 'Approve and queue publish' }).click()
  await expect(reviewer.getByRole('status').filter({ hasText: 'Approved snapshot queued' })).toContainText('publish worker')
  const queued = await reviewer.request.get('/__e2e/publish-state')
  expect(queued.ok(), await queued.text()).toBeTruthy()
  await expect(queued.json()).resolves.toMatchObject({ outbox: { status: 'pending' }, releaseCount: beforeApproval.releaseCount })
  expect(await reviewer.evaluate(async () => (await fetch('/api/editorial/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'worker-only' }) })).status)).toBe(409)
  await reviewer.getByLabel('Add review comment').fill('Browser review comment')
  await reviewer.getByRole('button', { name: 'Add comment' }).click()
  await expect(reviewer.getByText('Browser review comment')).toBeVisible()
  await reviewer.reload()
  await reviewer.locator(`[data-editorial-queue-item][data-change-set-id="${changeSetID}"]`).click()
  await expect(reviewer.getByTitle('Live comparison')).toBeVisible()
  expect((await reviewer.request.post('/__e2e/review-owner/disable')).status()).toBe(204)
  await reviewer.reload()
  await expect(reviewer).toHaveURL(/\/admin\/login/)
  await expect(reviewer.getByRole('heading', { name: 'Staff sign in' })).toBeVisible()
  await reviewerContext.close()

  await page.evaluate(async (id) => {
    await fetch(`/api/pages/${id}?draft=true`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Workflow refreshed' }) })
  }, created)
  await page.reload()
  await expect(page.locator('[data-editorial-detail] [data-editorial-state="open"]')).toBeVisible()
  await expect(page.locator(`[data-editorial-queue-item][data-change-set-id="${changeSetID}"] [data-editorial-state="approved"]`)).toBeVisible()
})

test('an owner schedules, reschedules, and cancels a reviewed future publication without queuing it immediately', async ({ browser, page }) => {
  test.setTimeout(60_000)
  await signIn(page, 'editor')
  const scheduledPageID = await page.evaluate(async () => {
    const section = await fetch('/api/sections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Scheduled workflow', summary: 'This synthetic section exercises reviewed future publication scheduling in a real browser.', slug: 'scheduled-workflow', allowedTemplates: ['standard'] }) })
    const sectionBody = await section.json() as { doc: { id: string } }
    const created = await fetch('/api/pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Scheduled workflow page', summary: 'This synthetic page provides a real reviewed candidate for a future publication.', slug: 'scheduled-workflow-page', sectionId: sectionBody.doc.id, template: 'standard' }) })
    const createdBody = await created.json() as { doc: { id: string } }
    await fetch(`/api/pages/${createdBody.doc.id}?draft=true`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Scheduled workflow revised' }) })
    return createdBody.doc.id
  })
  await page.goto('/admin/editorial'); const scheduledSetID = await selectCapturedSet(page, scheduledPageID); await page.getByRole('button', { name: 'Submit for review' }).click()
  const editorList = await page.evaluate(async () => (await fetch('/api/editorial/schedules/list')).status)
  expect(editorList).toBe(403)
  const ownerContext = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true }); const owner = await ownerContext.newPage()
  await signInLocalOwner(owner, scheduleOwnerRecoveryCode, scheduleOwnerEmail); await owner.goto('/admin/editorial'); await owner.clock.install({ time: new Date('2030-01-01T00:00:00.000Z') })
  await owner.locator(`[data-editorial-queue-item][data-change-set-id="${scheduledSetID}"]`).click(); await owner.getByRole('button', { name: 'Prepare comparison' }).click()
  const headers = { authorization: 'Bearer synthetic-preview-worker-token-long-enough-for-browser-tests', 'content-type': 'application/json' }
  const claimed = await owner.request.post('/api/internal/preview-jobs/claim', { headers, data: {} }); const claim = await claimed.json() as { job: { id: string; leaseToken: string }; live: unknown; proposed: unknown }
  const hash = async (value: unknown) => owner.evaluate(async (input) => { const stable = (item: unknown): string => Array.isArray(item) ? `[${item.map(stable).join(',')}]` : item && typeof item === 'object' ? `{${Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}` : JSON.stringify(item); const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(input))); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }, value)
  expect((await owner.request.post('/api/internal/preview-jobs/complete', { headers, data: { id: claim.job.id, leaseToken: claim.job.leaseToken, liveManifestHash: await hash(claim.live), proposedManifestHash: await hash(claim.proposed), artifactDigest: 'c'.repeat(64) } })).ok()).toBeTruthy()
  await expect(owner.getByRole('button', { name: 'Run readiness checks' })).toBeVisible({ timeout: 10_000 }); await owner.getByRole('button', { name: 'Run readiness checks' }).click()
  const beforeSchedule = await (await owner.request.get('/__e2e/publish-state')).json() as { outbox?: unknown }
  const future = '2031-01-02T03:04'; await owner.locator('input[type="datetime-local"]').fill(future); await owner.getByRole('button', { name: 'Approve and schedule publish' }).click()
  await expect(owner.getByRole('main').getByRole('status')).toContainText('scheduled for UTC dispatch'); await expect(owner.getByText('UTC 2031-01-02T03:04:00.000Z')).toBeVisible()
  const state = await (await owner.request.get('/__e2e/publish-state')).json() as { outbox?: unknown }; expect(state.outbox).toEqual(beforeSchedule.outbox)
  owner.once('dialog', dialog => dialog.accept('2031-01-02T04:04')); await owner.getByRole('button', { name: 'Reschedule' }).click(); await expect(owner.getByText('UTC 2031-01-02T04:04:00.000Z')).toBeVisible()
  await owner.getByRole('button', { name: 'Cancel schedule' }).click(); await expect(owner.getByText('Scheduled publication cancelled.', { exact: true })).toBeVisible(); await expect(owner.locator(`[data-editorial-queue-item][data-change-set-id="${scheduledSetID}"] [data-editorial-state="changes-requested"]`)).toBeVisible()
  const seeded = await owner.request.post('/__e2e/schedule-page'); expect(seeded.ok(), await seeded.text()).toBeTruthy(); await owner.reload()
  await expect(owner.getByText('Page 1 of 2')).toBeVisible(); await expect(owner.getByRole('button', { name: 'Next schedules' })).toBeEnabled(); await owner.getByRole('button', { name: 'Next schedules' }).click(); await expect(owner.getByText('Page 2 of 2')).toBeVisible(); await expect(owner.getByRole('button', { name: 'Previous schedules' })).toBeEnabled()
  await ownerContext.close()
})

test('logout revokes the session, replays are denied, and cross-origin POST is blocked by Next proxy', async ({ page }) => {
  const callbackURL = await signIn(page, 'editor')
  const logoutStatus = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status)
  expect(logoutStatus).toBe(204)
  const afterLogout = await page.request.get('/api/users/me')
  const afterLogoutBody = await afterLogout.json() as { user?: unknown }
  expect(afterLogoutBody.user ?? null).toBeNull()
  const protectedAfterLogout = await page.request.get('/api/users')
  expect(protectedAfterLogout.status()).toBeGreaterThanOrEqual(400)

  await page.goto(callbackURL)
  await expect(page.locator('body')).toContainText(/Sign-in browser binding is invalid|Sign-in request expired or was already used/)

  await page.goto(`${issuerOrigin}/cross-origin-post`)
  await page.getByRole('button', { name: 'Submit cross-origin logout' }).click()
  await expect(page.locator('body')).toContainText('CSRF origin check failed.')
})

test('ENG-019 exposes accessible public validation and queues an urgent inquiry', async ({ page }) => {
  await page.goto('/general/gallery')
  let inquiryPosts = 0
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/inquiries') inquiryPosts += 1 })
  await page.getByRole('button', { name: 'Send inquiry' }).click()
  await expect(page.locator('[data-inquiry-field-error="email"]')).toHaveText('Enter a valid email address.')
  await expect(page.locator('[data-inquiry-field-error="consent"]')).toHaveText('Consent is required before sending an inquiry.')
  expect(inquiryPosts).toBe(0)
  await page.locator('[name="name"]').fill('Incident visitor')
  await page.locator('[name="email"]').fill('incident.visitor@example.test')
  await page.locator('[name="telephone"]').fill('+1 555 0199')
  await page.locator('[name="company"]').fill('Example Company')
  await page.locator('[name="topic"]').selectOption('active-incident')
  await page.locator('[name="message"]').fill('Synthetic active incident test message.')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Send inquiry' }).click()
  await expect(page.locator('[data-inquiry-status]')).toContainText('received')
  await signInLocalOwner(page, 'synthetic-intake-owner-code-06', 'content-owner.synthetic@example.test')
  const leads = await page.request.get('/api/leads?urgent=true')
  expect(leads.ok()).toBeTruthy()
  const leadText = await leads.text()
  expect(leadText).toContain('Synthetic active incident test message.')
  expect(leadText).toContain('Incident visitor')
  expect(leadText).toContain('+1 555 0199')
  expect(leadText).toContain('Example Company')
})

test('the login page truthfully reports a disabled provider', async ({ page }) => {
  await page.goto('/admin/login')
  await expect(page.getByText('Microsoft sign-in is not configured.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible()
})

test('emergency owner UI rejects a wrong code and accepts a single-use recovery code', async ({ page }) => {
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('emergency-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill('wrong-code')
  await page.getByTestId('emergency-sign-in').click()
  await expect(page.getByTestId('emergency-sign-in-message')).toHaveText('Emergency sign-in was not accepted. Check your email and code, then try again.')
  await page.locator('#emergency-code').fill('synthetic-recovery-code-01')
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  const me = await page.request.get('/api/users/me')
  expect(await me.text()).toContain('emergency-owner.synthetic@example.test')
  expect(await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status)).toBe(204)
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('emergency-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill('synthetic-recovery-code-01')
  await page.getByTestId('emergency-sign-in').click()
  await expect(page.getByTestId('emergency-sign-in-message')).toHaveText('Emergency sign-in was not accepted. Check your email and code, then try again.')
})

test('a locally provisioned owner uses the authenticator without OIDC, browses collections, and is disabled authoritatively', async ({ page }) => {
  await signInLocalOwner(page)
  const collections = page.locator('details').filter({ has: page.locator('summary', { hasText: 'More tools' }) })
  await collections.locator('summary').click()
  const collectionNavigation = collections.getByRole('navigation', { name: 'More tools' })
  await expect(collectionNavigation.getByRole('link', { name: 'Pages', exact: true })).toBeVisible()
  await expect(collectionNavigation.getByRole('link', { name: 'Sections', exact: true })).toBeVisible()

  const me = await page.request.get('/api/users/me')
  expect(me.ok()).toBeTruthy()
  const meBody = await me.json() as { user?: { email?: string; provider?: unknown; providerIssuer?: unknown; providerSubject?: unknown } }
  expect(meBody.user?.email).toBe('emergency-owner.synthetic@example.test')
  expect(meBody.user?.provider).toBeNull()
  expect(meBody.user?.providerIssuer).toBeNull()
  expect(meBody.user?.providerSubject).toBeNull()

  for (const collection of ['pages', 'sections']) {
    const response = await page.goto(`/admin/collections/${collection}`)
    expect(response?.ok()).toBeTruthy()
    await expect(page).toHaveURL(new RegExp(`/admin/collections/${collection}(?:\\?.*)?$`))
  }

  const oldSession = (await page.context().cookies()).find((cookie) => cookie.name === '__Host-site_engine_session')
  expect(oldSession?.value).toBeTruthy()
  const logoutRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('logout')) logoutRequests.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  const logout = page.locator('[data-admin-account] a[href="/admin/logout"]')
  const accountMenu = page.getByRole('group', { name: 'Account menu' })
  await accountMenu.getByText('Synthetic Emergency Owner').click()
  await logout.click()
  await page.waitForURL(/\/admin\/login/)
  expect(logoutRequests).toContain('POST /api/auth/logout')
  const replayedSession = await page.request.get('/api/users/me', { headers: { cookie: `${oldSession!.name}=${oldSession!.value}` } })
  expect((await replayedSession.json() as { user?: unknown }).user ?? null).toBeNull()

  await signInLocalOwner(page, 'synthetic-local-recovery-code-03')
  const disabled = await page.request.post('/__e2e/local-owner/disable')
  expect(disabled.status()).toBe(204)
  const disabledMe = await page.request.get('/api/users/me')
  expect((await disabledMe.json() as { user?: unknown }).user ?? null).toBeNull()
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login/)
})
