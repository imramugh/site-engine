import { createRequire } from 'node:module'
import { expect, test, type Browser } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
async function signedIn(browser: Browser) { const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true }); await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-theme-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const }))); return { context, page: await context.newPage() } }
type MailboxMock = { id: string; name: string; provider: 'smtp'; primaryAddress: string; aliases: string[]; verifiedAliases: string[]; host: string; port: number; security: 'starttls'; username: string; health: string; testedAt: string | null; credentialConfigured: boolean; credentialHint: string }
const mailbox: MailboxMock = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic mailbox', provider: 'smtp', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'synthetic-user', health: 'unknown', testedAt: null, credentialConfigured: true, credentialHint: 'configured • a1b2c3d4e5f60718' }

test('Owner configures SMTP, assigns areas, and explicitly authorizes a test send at desktop and mobile sizes', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser); let mailboxes: MailboxMock[] = []; let mappings: Array<{ id: string; area: string; mailbox: string; senderAddress: string }> = []; const posts: Record<string, unknown>[] = []
  const response = () => ({ providers: { microsoft: { status: 'available' }, google: { status: 'available' }, smtp: { status: mailboxes[0]?.health === 'connected' ? 'connected' : mailboxes.length ? 'configured' : 'available' } }, mailboxes, mappings })
  await owner.page.route('**/api/email-workspace', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: response() })
    const body = route.request().postDataJSON() as Record<string, unknown>; posts.push(body)
    if (body.action === 'configure-smtp') mailboxes = [mailbox]
    if (body.action === 'test-connection') mailboxes = [{ ...mailbox, health: 'connected', testedAt: '2026-10-05T12:00:00.000Z' }]
    if (body.action === 'send-test') mailboxes = [{ ...mailbox, health: 'connected', testedAt: '2026-10-05T12:00:00.000Z', verifiedAliases: body.senderAddress === 'careers@example.test' ? ['careers@example.test'] : [] }]
    if (body.action === 'map-area') mappings = [...mappings.filter((item) => item.area !== body.area), { id: crypto.randomUUID(), area: String(body.area), mailbox: String(body.mailbox), senderAddress: String(body.senderAddress) }]
    if (body.action === 'clear-area') mappings = mappings.filter((item) => item.area !== body.area)
    return route.fulfill({ json: response() })
  })
  await owner.page.setViewportSize({ width: 1440, height: 900 }); await owner.page.goto('/integrations?tab=email')
  await expect(owner.page.locator('[data-email-providers] article')).toHaveCount(3); await expect(owner.page.locator('[data-email-provider="microsoft"]')).toContainText('Available'); await expect(owner.page.locator('[data-email-provider="google"]')).toContainText('Available'); await expect(owner.page.locator('[data-email-provider="microsoft"]')).toContainText('Connect a mailbox with your Owner account.')
  await owner.page.getByRole('button', { name: 'Configure' }).click(); await owner.page.getByLabel('Mailbox name').fill('Synthetic mailbox'); await owner.page.getByLabel('Primary address').fill('hello@example.test'); await owner.page.getByLabel('Aliases').fill('careers@example.test'); await owner.page.getByLabel('SMTP host').fill('smtp.example.test'); await owner.page.getByLabel('Username').fill('synthetic-user'); await owner.page.getByLabel('Password').fill('browser-only-secret'); await owner.page.getByRole('button', { name: 'Save mailbox' }).click(); await expect(owner.page.getByRole('status')).toContainText('SMTP mailbox saved')
  expect(JSON.stringify(posts.at(-1))).toContain('browser-only-secret'); await expect(owner.page.locator('main')).not.toContainText('browser-only-secret'); await expect(owner.page.locator('main')).not.toContainText(mailbox.credentialHint)
  await owner.page.getByRole('button', { name: 'Test connection' }).click(); await expect(owner.page.getByRole('status')).toContainText('SMTP connection test completed'); await expect(owner.page.getByText('Connection verified')).toBeVisible()
  await owner.page.getByLabel('Leads sender address').selectOption(`${mailbox.id}|hello@example.test`); await expect(owner.page.getByRole('status')).toContainText('Leads sender updated')
  await owner.page.getByRole('button', { name: 'Send test' }).click(); await expect(owner.page.getByText('Mailbox delivery test', { exact: true })).toBeVisible(); await expect(owner.page.getByText('This synthetic test confirms that the configured mailbox can deliver email.', { exact: true })).toBeVisible(); await owner.page.getByLabel('From').selectOption('careers@example.test'); await owner.page.getByLabel('Recipient').fill('synthetic-sink@example.test'); await expect(owner.page.getByRole('button', { name: 'Authorize and send' })).toBeDisabled(); await owner.page.getByLabel('I authorize this exact one-time test message.').check(); await owner.page.getByRole('button', { name: 'Authorize and send' }).click(); await expect(owner.page.getByRole('status')).toContainText('accepted by the configured SMTP service')
  expect(posts.at(-1)).toMatchObject({ action: 'send-test', confirmed: true, recipientAddress: 'synthetic-sink@example.test', senderAddress: 'careers@example.test', subject: 'Mailbox delivery test' })
  await owner.page.getByLabel('Careers sender address').selectOption(`${mailbox.id}|careers@example.test`); await expect(owner.page.getByRole('status')).toContainText('Careers sender updated')
  await owner.page.getByLabel('Notifications sender address').selectOption(`${mailbox.id}|hello@example.test`); await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'map-area', area: 'notifications' }); await owner.page.getByLabel('Notifications sender address').selectOption(''); await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'clear-area', area: 'notifications' })
  await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]); await owner.page.screenshot({ path: testInfo.outputPath('email-workspace-1440.png'), fullPage: true })
  await owner.page.setViewportSize({ width: 390, height: 844 }); expect(await owner.page.locator('main').evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]); await owner.page.screenshot({ path: testInfo.outputPath('email-workspace-390.png'), fullPage: true }); await owner.context.close()
})

test('Owner sees OAuth mailbox availability and mocked authorization results without credential exposure', async ({ browser }) => {
  const owner = await signedIn(browser)
  const response = () => ({ providers: { microsoft: { status: 'available' }, google: { status: 'unconfigured', setupMessage: 'Configure the mailbox OAuth client ID and secret before connecting.' }, smtp: { status: 'available' } }, mailboxes: [], mappings: [] })
  await owner.page.route('**/api/email-workspace', (route) => route.fulfill({ json: response() }))
  await owner.page.route('**/api/email-workspace/oauth/microsoft', (route) => route.fulfill({ contentType: 'text/html', body: '<main>Mock Microsoft consent</main>' }))
  await owner.page.goto('/integrations?tab=email')
  await expect(owner.page.locator('[data-email-provider="microsoft"]')).toContainText('Available')
  await expect(owner.page.locator('[data-email-provider="google"]')).toContainText('Setup required')
  await expect(owner.page.locator('[data-email-provider="google"]')).toContainText('Configure the mailbox OAuth client ID and secret before connecting.')
  await expect(owner.page.locator('[data-email-provider="google"]').getByRole('button')).toHaveCount(0)
  await owner.page.locator('[data-email-provider="microsoft"]').getByRole('button', { name: 'Connect' }).click()
  await expect(owner.page).toHaveURL(/\/api\/email-workspace\/oauth\/microsoft$/)
  await owner.page.goto('/integrations?tab=email&mailbox=connected&provider=microsoft')
  await expect(owner.page.locator('[data-email-workspace]').getByRole('status')).toContainText('Microsoft 365 mailbox connected.')
  await expect(owner.page.locator('main')).not.toContainText('synthetic-code')
  await owner.page.goto('/integrations?tab=email&mailbox=authorization_failed&provider=google')
  await expect(owner.page.locator('[data-email-workspace] [role="alert"]')).toContainText('Mailbox authorization could not be completed. No mailbox was connected.')
  await owner.context.close()
})
