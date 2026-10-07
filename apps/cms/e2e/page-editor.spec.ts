import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const pageID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe'
const metadataArticleID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba3'
const metadataServiceID = 'abcd0000-0000-4000-8000-000000000003'
const metadataJobID = 'abcd0000-0000-4000-8000-000000000004'

async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  })
  await context.addCookies(
    ['site_engine_session', '__Host-site_engine_session'].map((name) => ({
      name,
      value: token,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax' as const,
    })),
  )
  return { context, page: await context.newPage() }
}

async function attachRenderedFontEvidence(page: Page, testInfo: TestInfo) {
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument')
  const evidence = []
  for (const [name, selector] of [
    ['page title', '[data-page-editor] h1'],
    ['title label', '[data-page-editor-fields] label'],
    ['title input', '[data-page-editor-fields] input'],
    ['block summary', '[data-page-editor-block] summary strong'],
    ['save action', '[data-page-editor-actions] button'],
  ] as const) {
    const { nodeId } = await session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    })
    expect(nodeId, `${name} node exists for platform font evidence`).toBeTruthy()
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', {
      nodeId,
    })
    expect(
      fonts.length,
      `${name} has a rendered platform font`,
    ).toBeGreaterThan(0)
    evidence.push({ name, selector, fonts })
  }
  await testInfo.attach('rendered-platform-fonts', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  })
  if (process.env.ADMIN_BRANDING_DIR) {
    expect(
      evidence.every(({ fonts }) =>
        fonts.some(
          (font) =>
            font.isCustomFont && font.familyName.startsWith('IBM Plex Sans'),
        ),
      ),
      JSON.stringify(evidence),
    ).toBe(true)
  }
  await session.detach()
  return evidence
}

test('ENG-006/ENG-026 edits an ordered page, renders the saved draft, and submits without publishing', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const editor = await signedIn(
    browser,
    'synthetic-page-editor-owner-session-token',
  )
  const before = (await editor.page.request
    .get('/__e2e/publish-state')
    .then((response) => response.json())) as { releaseCount: number }
  await editor.page.setViewportSize({ width: 1440, height: 900 })
  await editor.page.goto('/content-tree')
  await editor.page
    .getByRole('link', { name: /Page editor browser page/ })
    .click()
  await expect(editor.page).toHaveURL(new RegExp(`/content-editor/${pageID}$`))
  await expect(editor.page.locator('[data-admin-page-title]')).toHaveText(
    'Edit page',
  )
  expect(
    await editor.page.locator('[data-page-editor]').getAttribute(
      'data-page-editor-theme',
    ),
  ).toBeNull()
  await expect(
    editor.page.locator('[data-page-editor-preview]').getByText(
      /Saved draft preview · Theme unavailable/,
    ),
  ).toBeVisible()
  await expect(
    editor.page.locator(
      '[data-admin-primary] [data-admin-nav-item][href="/content-tree"]',
    ),
  ).toHaveAttribute('aria-current', 'page')
  await expect(
    editor.page.getByRole('heading', {
      name: 'Page editor browser page',
      exact: true,
    }),
  ).toBeVisible()
  await expect(editor.page.locator('[data-page-state]')).toContainText(
    'published',
  )
  await expect(
    editor.page.locator('[data-page-editor-breadcrumb]'),
  ).toContainText('Direct edit browser section')

  const hero = editor.page.locator('[data-page-editor-block]').first()
  await hero.locator('summary').click()
  const heroOptionalActions = hero.getByRole('button', {
    name: /^(\+ )?(Eyebrow|Cta|Secondary Cta|Phone Cta|Support Panel)$/,
  })
  await expect(heroOptionalActions).toHaveCount(5)
  for (const action of await heroOptionalActions.all()) {
    await expect(action).toBeVisible()
    expect(
      await action.evaluate((node) => {
        const style = getComputedStyle(node)
        return { background: style.backgroundColor, color: style.color }
      }),
    ).toEqual({ background: 'rgb(255, 255, 255)', color: 'rgb(15, 27, 38)' })
  }

  await editor.page.getByText('Page fields', { exact: false }).first().click()
  await editor.page
    .getByLabel('Title', { exact: true })
    .fill('Browser saved full page')
  await editor.page.getByRole('button', { name: 'Add block' }).click()
  let dialog = editor.page.getByRole('dialog', { name: 'Add a block' })
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  await expect(dialog.locator('[data-page-block-type]')).toHaveCount(18)
  // Media-dependent recipes become available after earlier upload scenarios.
  // The required FAQ flow must remain available independently of those assets.
  await expect(dialog.locator('[data-page-block-type="faq"]')).toBeEnabled()
  await editor.page.keyboard.press('Shift+Tab')
  await expect(
    dialog.locator('[data-page-block-type]:enabled').last(),
  ).toBeFocused()
  await editor.page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  await editor.page.keyboard.press('Escape')
  await expect(
    editor.page.getByRole('button', { name: 'Add block' }),
  ).toBeFocused()
  await editor.page.getByRole('button', { name: 'Add block' }).click()
  dialog = editor.page.getByRole('dialog', { name: 'Add a block' })
  await dialog.getByRole('button', { name: /Faq/i }).click()
  await expect(editor.page.locator('[data-page-editor-block]')).toHaveCount(3)
  let faq = editor.page.locator('[data-page-editor-block]').nth(2)
  await expect(faq.locator('summary')).toContainText('Faq')
  await faq.locator('summary').click()
  await faq
    .getByLabel('Heading', { exact: true })
    .fill('Saved browser questions')
  await faq
    .getByLabel('Question', { exact: true })
    .fill('Does the complete editor render?')
  await faq
    .locator('textarea')
    .first()
    .fill('Yes, the real Astro preview renders this saved ordered block.')
  await expect(
    editor.page.locator('[data-page-editor-block][open]'),
  ).toHaveCount(1)
  await expect(faq.locator('[data-page-editor-background]')).toHaveCount(6)
  await faq.getByRole('button', { name: 'Highlight background' }).click()
  await expect(
    faq.getByRole('button', { name: 'Highlight background' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await faq.getByRole('button', { name: 'Move up' }).click()
  faq = editor.page.locator('[data-page-editor-block]').nth(1)
  await expect(faq.getByLabel('Heading', { exact: true })).toHaveValue(
    'Saved browser questions',
  )
  const contact = editor.page
    .locator('[data-page-editor-block]')
    .filter({ hasText: 'Contact' })
  await contact.locator('summary').click()
  await contact.getByRole('button', { name: 'Remove block' }).click()
  await expect(editor.page.locator('[data-page-editor-block]')).toHaveCount(2)
  await expect(
    editor.page.getByText('You have unsaved page changes.'),
  ).toBeVisible()
  await expect(
    editor.page.getByRole('button', { name: 'Submit for review' }),
  ).toBeDisabled()

  const queued = editor.page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/editorial/direct-edit/preview') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  )
  await editor.page.getByRole('button', { name: 'Check draft' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Draft checks are ready')
  const readiness = editor.page.locator('[data-page-editor-readiness]')
  await expect(readiness).toContainText('Draft is valid to save')
  const detailSummary = readiness.locator('summary')
  if (await detailSummary.count()) { await detailSummary.click(); await expect(readiness.locator('li').first()).toBeVisible() }
  await editor.page.getByRole('button', { name: 'Save draft' }).click()
  await queued
  const worker = await editor.page.request.post('/__e2e/direct-preview-worker')
  expect(worker.status(), await worker.text()).toBe(200)
  await expect(editor.page.getByRole('status')).toContainText(
    'Saved draft preview is ready.',
    { timeout: 120_000 },
  )
  const preview = editor.page.frameLocator(
    'iframe[title="Saved page draft preview"]',
  )
  await expect(
    preview
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Browser saved full page', exact: true }),
  ).toBeVisible()
  await expect(
    preview.getByRole('heading', { name: 'Page editor original heading' }),
  ).toBeVisible()
  await expect(preview.getByText('Page editor original body.')).toBeVisible()
  await expect(preview.getByText('Saved browser questions')).toBeVisible()
  await expect(
    preview.getByText('Does the complete editor render?'),
  ).toBeVisible()
  await expect(preview.getByText('Original contact block')).toHaveCount(0)
  await expect(
    editor.page.locator('[data-page-editor-preview-selection]'),
  ).toContainText('Select a rendered block')
  await expect(editor.page.getByRole('button', { name: 'Edit text in preview' })).toBeEnabled()
  await expect(
    editor.page.locator('[data-page-editor-preview] > header'),
  ).toContainText(/Saved draft preview · \S+ \S+/)
  const renderedBlocks = preview.locator('[data-page-editor-preview-block-id]')
  await expect(renderedBlocks).toHaveCount(2)
  const previewEdit = editor.page.getByRole('button', { name: 'Edit text in preview' })
  await expect(previewEdit).toBeEnabled()
  await expect(preview.getByRole('navigation', { name: 'Primary' }).locator('[data-site-engine-edit-field], [contenteditable]')).toHaveCount(0)
  await previewEdit.click()
  const previewHeading = preview.locator('[data-site-engine-edit-field="heading"]').first()
  await expect(previewHeading).toHaveAttribute('contenteditable', 'plaintext-only')
  await expect(previewHeading).toHaveCSS('outline-style', 'solid')
  await previewHeading.fill('Preview keyboard heading')
  await previewHeading.press('Tab')
  await expect(previewHeading).toHaveText('Preview keyboard heading')
  await previewHeading.evaluate((node) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    Object.defineProperty(event, 'isComposing', { value: true })
    node.dispatchEvent(event)
  })
  await expect(editor.page.getByRole('button', { name: 'Finish preview text editing' })).toBeVisible()
  await editor.page.getByRole('button', { name: 'Finish preview text editing' }).click()
  await editor.page.locator('[data-page-editor-block]').first().locator('summary').click()
  await expect(editor.page.locator('[data-page-editor-block]').first().getByLabel('Heading', { exact: true })).toHaveValue('Preview keyboard heading')
  const inlineQueued = editor.page.waitForResponse((response) => response.url().endsWith('/api/editorial/direct-edit/preview') && response.request().method() === 'POST' && response.status() === 200)
  await editor.page.getByRole('button', { name: 'Check draft' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Draft checks are ready')
  await editor.page.getByRole('button', { name: 'Save draft' }).click()
  await inlineQueued
  expect((await editor.page.request.post('/__e2e/direct-preview-worker')).status()).toBe(200)
  await expect(editor.page.getByRole('status')).toContainText('Saved draft preview is ready.', { timeout: 120_000 })
  await expect(preview.getByRole('heading', { name: 'Preview keyboard heading' })).toBeVisible()
  await editor.page.emulateMedia({ reducedMotion: 'reduce' })
  await renderedBlocks.first().click({ position: { x: 5, y: 5 } })
  await expect(
    editor.page.locator('[data-page-editor-block]').first(),
  ).toHaveAttribute('data-page-editor-block-active', 'true')
  await renderedBlocks.nth(1).focus()
  await renderedBlocks.nth(1).evaluate((node) => {
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      }),
    )
    window.parent.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    )
  })
  await expect(
    editor.page.locator('[data-page-editor-block]').nth(1),
  ).toHaveAttribute('data-page-editor-block-active', 'false')
  await expect(
    editor.page.locator('[data-page-editor-block][open]'),
  ).toHaveCount(0)
  const collapsedSummary = editor.page.locator('[data-page-editor-block]').nth(1).locator('summary')
  await expect(collapsedSummary).toBeFocused()
  await expect(editor.page.locator('[data-page-editor-block][open]')).toHaveCount(0)
  await collapsedSummary.press('Enter')
  await expect(editor.page.locator('[data-page-editor-block]').nth(1)).toHaveAttribute('open', '')
  const headingAfterReopen = editor.page.locator('[data-page-editor-block]').nth(1).getByLabel('Heading', { exact: true })
  await headingAfterReopen.focus()
  await headingAfterReopen.press('Escape')
  await expect(collapsedSummary).toBeFocused()
  await expect(editor.page.locator('[data-page-editor-block][open]')).toHaveCount(0)
  const previewTypeAttribute = await renderedBlocks.first().evaluate((node) => {
    const name = node.hasAttribute('data-block-type')
      ? 'data-block-type'
      : 'data-block'
    const value = node.getAttribute(name)!
    node.setAttribute(name, 'unmatched-block')
    return { name, value }
  })
  await editor.page.getByTitle('Saved page draft preview').dispatchEvent('load')
  await expect(
    editor.page.locator('[data-page-editor-preview-selection]'),
  ).toContainText('unavailable')
  await expect(editor.page.getByRole('button', { name: 'Edit text in preview' })).toBeDisabled()
  await expect(renderedBlocks).toHaveCount(0)
  await preview
    .locator(`[${previewTypeAttribute.name}]`)
    .first()
    .evaluate(
      (node, attribute) => node.setAttribute(attribute.name, attribute.value),
      previewTypeAttribute,
    )
  await editor.page.getByTitle('Saved page draft preview').dispatchEvent('load')
  await expect(
    editor.page.locator('[data-page-editor-preview-selection]'),
  ).toContainText('Select a rendered block')
  await expect(editor.page.getByRole('button', { name: 'Edit text in preview' })).toBeEnabled()
  await preview.locator('[data-block-id]').first().evaluate((node) => {
    const duplicate = document.createElement('span')
    duplicate.dataset.siteEngineEditField = 'heading'
    duplicate.textContent = node.querySelector('[data-site-engine-edit-field="heading"]')?.textContent ?? ''
    duplicate.dataset.e2eDuplicateMarker = 'true'
    node.append(duplicate)
  })
  await editor.page.getByTitle('Saved page draft preview').dispatchEvent('load')
  await expect(editor.page.getByRole('button', { name: 'Edit text in preview' })).toBeDisabled()
  await preview.locator('[data-e2e-duplicate-marker="true"]').evaluate((node) => node.remove())
  await editor.page.getByTitle('Saved page draft preview').dispatchEvent('load')
  await expect(editor.page.getByRole('button', { name: 'Edit text in preview' })).toBeEnabled()
  expect(
    await editor.page
      .getByTitle('Saved page draft preview')
      .evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.innerWidth),
  ).toBe(1280)
  const previewURL = await editor.page
    .getByTitle('Saved page draft preview')
    .getAttribute('src')
  expect(previewURL).toMatch(
    /^\/preview\/changes\/[0-9a-f-]+\/proposed\/direct-edit-browser\/page-editor-browser-page$/,
  )
  const anonymous = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  })
  expect((await anonymous.request.get(previewURL!)).status()).toBe(401)
  await anonymous.close()

  await editor.page.addScriptTag({ path: axeSource })
  expect(
    await editor.page.evaluate(
      async () =>
        (
          await (
            window as unknown as { axe: typeof import('axe-core') }
          ).axe.run('main')
        ).violations,
    ),
  ).toEqual([])
  const fontEvidence = await attachRenderedFontEvidence(editor.page, testInfo)
  console.info(`Rendered platform fonts: ${JSON.stringify(fontEvidence)}`)
  await faq.locator('summary').click()
  await expect(faq).toHaveAttribute('open', '')
  const desktopShellGeometry = await editor.page.evaluate(async () => {
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect()
      return { top: rect.top, left: rect.left }
    }
    return {
      scrollY: window.scrollY,
      sidebar: bounds('[data-admin-sidebar]'),
      header: bounds('[data-admin-header]'),
    }
  })
  expect(desktopShellGeometry.scrollY).toBe(0)
  expect(desktopShellGeometry.sidebar.top).toBe(0)
  expect(desktopShellGeometry.sidebar.left).toBe(0)
  expect(desktopShellGeometry.header.top).toBe(0)
  expect(desktopShellGeometry.header.left).toBe(240)
  await editor.page.screenshot({
    path: 'artifacts/page-editor-1440.png',
    fullPage: true,
  })
  await editor.page.setViewportSize({ width: 390, height: 844 })
  await editor.page.getByRole('button', { name: 'Mobile' }).click()
  expect(
    await editor.page
      .getByTitle('Saved page draft preview')
      .evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.innerWidth),
  ).toBe(390)
  const mobileLayout = await editor.page
    .locator('main')
    .evaluate((node: HTMLElement) => {
      const bounds = node.getBoundingClientRect()
      return {
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        overflowing: [...node.querySelectorAll<HTMLElement>('*')]
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return (
              style.position !== 'fixed' &&
              (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
            )
          })
          .slice(0, 10)
          .map((element) => ({
            element: `${element.tagName.toLowerCase()}.${element.className}`,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          })),
      }
    })
  expect(
    mobileLayout.scrollWidth,
    JSON.stringify(mobileLayout),
  ).toBeLessThanOrEqual(mobileLayout.clientWidth)
  expect(
    await editor.page
      .locator('html')
      .evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth),
  ).toBe(true)
  expect(
    await editor.page.evaluate(
      async () =>
        (
          await (
            window as unknown as { axe: typeof import('axe-core') }
          ).axe.run('main')
        ).violations,
    ),
  ).toEqual([])
  await editor.page.screenshot({
    path: 'artifacts/page-editor-390.png',
    fullPage: true,
  })

  const staleHero = editor.page.locator('[data-page-editor-block]').first()
  if (await staleHero.getAttribute('open') === null) await staleHero.locator('summary').click()
  const inlineHeadingField = staleHero.getByLabel('Heading', { exact: true })
  await expect(inlineHeadingField).toBeVisible()
  await inlineHeadingField.fill('Stale local preview text')
  await editor.page.getByRole('button', { name: 'Check draft' }).click()
  await expect(editor.page.locator('[data-page-editor-readiness]')).toContainText(/Draft is valid|Checks passed/)
  await editor.page.route(`**/api/editorial/page-editor/${pageID}`, async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This draft or change set changed. Reload before saving.' }) })
    else await route.continue()
  })
  await editor.page.getByRole('button', { name: 'Save draft' }).click()
  await expect(editor.page.locator('[data-page-editor-stale]')).toContainText('unsaved text is still available')
  await expect(inlineHeadingField).toHaveValue('Stale local preview text')
  editor.page.once('dialog', (dialog) => dialog.accept())
  await editor.page.getByRole('button', { name: 'Reload and discard changes' }).click()
  await expect(inlineHeadingField).toHaveValue('Preview keyboard heading')
  await editor.page.unroute(`**/api/editorial/page-editor/${pageID}`)
  const requeuedPreview = editor.page.waitForResponse((response) =>
    response.url().endsWith('/api/editorial/direct-edit/preview') &&
    response.request().method() === 'POST' &&
    response.status() === 200,
  )
  await editor.page.getByRole('button', { name: 'Prepare preview' }).click()
  const reusedPreview = await requeuedPreview
  const reusedJob = (await reusedPreview.json()) as { job?: { status?: string } }
  if (reusedJob.job?.status !== 'completed')
    expect((await editor.page.request.post('/__e2e/direct-preview-worker')).status()).toBe(200)
  await expect(editor.page.getByRole('status')).toContainText('Saved draft preview is ready.', { timeout: 120_000 })
  await expect(preview.getByRole('heading', { name: 'Preview keyboard heading' })).toBeVisible()
  await editor.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(editor.page.getByRole('status')).toContainText(
    'Submitted for review.',
  )
  expect(
    (
      (await editor.page.request
        .get('/__e2e/publish-state')
        .then((response) => response.json())) as { releaseCount: number }
    ).releaseCount,
  ).toBe(before.releaseCount)
  expect((await editor.page.request.get(previewURL!)).status()).toBe(403)
  await editor.context.close()

  const hiring = await signedIn(
    browser,
    'synthetic-application-hiring-session-token',
  )
  await hiring.page.goto(`/content-editor/${pageID}`)
  await expect(hiring.page).toHaveURL(/\/admin\/login/)
  await hiring.context.close()
})

test('ENG-006 persists service, article, business-case, and job metadata through the real editor', async ({ browser }) => {
  test.setTimeout(120_000)
  const editor = await signedIn(browser, 'synthetic-metadata-editor-owner-session-token')
  const openFields = async (id: string) => {
    await editor.page.goto(`/content-editor/${id}`)
    await editor.page.getByText('Page fields', { exact: false }).first().click()
  }
  const saveAndReload = async (id: string) => {
    const saved = editor.page.waitForResponse((response) => response.url().endsWith(`/api/editorial/page-editor/${id}`) && response.request().method() === 'POST')
    const queued = editor.page.waitForResponse((response) => response.url().endsWith('/api/editorial/direct-edit/preview') && response.request().method() === 'POST')
    await editor.page.getByRole('button', { name: 'Check draft' }).click()
    await expect(editor.page.getByRole('status')).toContainText('Draft checks are ready')
    await editor.page.getByRole('button', { name: 'Save draft' }).click()
    const [savedResponse, queuedResponse] = await Promise.all([saved, queued])
    expect(savedResponse.status(), await savedResponse.text()).toBe(200)
    expect(queuedResponse.status(), await queuedResponse.text()).toBe(200)
    await expect(editor.page.getByRole('button', { name: 'Save draft' })).toBeDisabled()
    const worker = await editor.page.request.post('/__e2e/direct-preview-worker')
    expect(worker.status(), await worker.text()).toBe(200)
    await expect(editor.page.getByRole('status')).toContainText('Saved draft preview is ready.', { timeout: 120_000 })
    await editor.page.reload()
    await editor.page.getByText('Page fields', { exact: false }).first().click()
  }

  await openFields(metadataArticleID)
  await editor.page.getByLabel('Published').fill('2026-09-29')
  await editor.page.getByLabel('Last reviewed').fill('2026-10-01')
  await editor.page.getByRole('button', { name: 'Add business case details' }).click()
  await editor.page.getByLabel('Client', { exact: true }).fill('Synthetic organization')
  await editor.page.getByLabel('Industry').fill('Professional services')
  await editor.page.getByLabel('Challenge').fill('A synthetic business challenge.')
  await editor.page.getByLabel('Approach').fill('A synthetic delivery approach.')
  await editor.page.getByLabel('Outcome').fill('A synthetic measured outcome.')
  const services = editor.page.getByLabel(/Services Separate names with commas/)
  await services.pressSequentially('Advisory, Strategy')
  await expect(services).toHaveValue('Advisory, Strategy')
  await editor.page.getByLabel('Case publication date').fill('2026-09-30')
  await editor.page.addScriptTag({ path: axeSource })
  const metadataViolations = await editor.page.evaluate(async () =>
    // @ts-expect-error axe is injected for browser accessibility verification.
    (await window.axe.run('main')).violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node: { target: string[] }) => node.target),
    })),
  )
  expect(metadataViolations).toEqual([])
  await saveAndReload(metadataArticleID)
  await expect(editor.page.getByLabel('Published')).toHaveValue('2026-09-29')
  await expect(editor.page.getByLabel('Last reviewed')).toHaveValue('2026-10-01')
  await expect(editor.page.getByLabel('Client', { exact: true })).toHaveValue('Synthetic organization')
  await expect(editor.page.getByLabel(/Services Separate names with commas/)).toHaveValue('Advisory, Strategy')

  await openFields(metadataServiceID)
  await editor.page.getByLabel('Kicker').fill('Advisory')
  await editor.page.getByLabel('Lede').fill('A persisted service introduction.')
  await editor.page.getByLabel('Last reviewed').fill('2026-10-02')
  await saveAndReload(metadataServiceID)
  await expect(editor.page.getByLabel('Kicker')).toHaveValue('Advisory')
  await expect(editor.page.getByLabel('Lede')).toHaveValue('A persisted service introduction.')
  await expect(editor.page.getByLabel('Last reviewed')).toHaveValue('2026-10-02')

  await openFields(metadataJobID)
  await editor.page.getByRole('button', { name: 'Add job posting details' }).click()
  await editor.page.getByLabel('Date posted').fill('2026-10-01')
  await editor.page.getByLabel('Employment type').selectOption('CONTRACTOR')
  await editor.page.getByLabel('City or locality').fill('Example City')
  await editor.page.getByLabel('Region').fill('Region')
  await editor.page.getByLabel(/Country code/).fill('ca')
  await editor.page.getByLabel('Closing date').fill('2026-11-01')
  await saveAndReload(metadataJobID)
  await expect(editor.page.getByLabel('Employment type')).toHaveValue('CONTRACTOR')
  await expect(editor.page.getByLabel('City or locality')).toHaveValue('Example City')
  await expect(editor.page.getByLabel(/Country code/)).toHaveValue('CA')
  await expect(editor.page.getByLabel('Closing date')).toHaveValue('2026-11-01')
  await editor.context.close()
})
