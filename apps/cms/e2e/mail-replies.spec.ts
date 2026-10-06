import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

async function composer(browser: Browser, sendFails = false) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  const requests: string[] = []
  await page.route('**/api/mail-replies/lead/**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { senders: [{ address: 'team@example.test', label: 'Team mailbox' }], canAuthorize: true } })
    const body = route.request().postDataJSON()
    requests.push(body.action)
    if (body.action === 'prepare') return route.fulfill({ json: { draft: { id: '11111111-1111-4111-8111-111111111111', sender: 'team@example.test', recipient: 'notes-a.synthetic@example.test', subject: body.subject.trim(), body: body.body.trim() } } })
    if (body.action === 'send' && sendFails) return route.fulfill({ status: 503, json: { error: 'Provider acknowledgement was lost.' } })
    return route.fulfill({ json: { authorization: { id: '22222222-2222-4222-8222-222222222222' } } })
  })
  await page.goto('/leads')
  await page.getByRole('button', { name: /First editable lead/ }).click()
  const reply = page.locator('[data-mail-reply-composer]')
  await expect(reply.getByLabel('Reply sender')).toHaveValue('team@example.test')
  await reply.getByLabel('Reply subject').fill('  Exact subject  ')
  await reply.getByLabel('Reply message').fill('  Exact body  ')
  await reply.getByRole('button', { name: 'Prepare reply' }).click()
  return { context, page, reply, requests }
}

test('ENG-020/033 reviews the persisted envelope, reconfirms edits, and cannot resend a completed reply', async ({ browser }) => {
  const { context, page, reply, requests } = await composer(browser)
  try {
    const review = reply.getByRole('region', { name: 'Exact reply review' })
    await expect(review).toContainText('team@example.test')
    await expect(review).toContainText('notes-a.synthetic@example.test')
    await expect(review.locator('dd').last()).toHaveText('Exact subject')
    await expect(review.locator('p')).toHaveText('Exact body')
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Cancel confirmation and edit' }).click()
    await reply.getByLabel('Reply message').fill('Changed body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await expect(review).toContainText('Changed body')
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toHaveCount(0)
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    await expect(reply.getByRole('status')).toHaveText('Reply sent.')
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toHaveCount(0)
    expect(requests).toEqual(['prepare', 'authorize', 'cancel', 'prepare', 'authorize', 'send'])
    await page.addScriptTag({ path: axe })
    expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  } finally { await context.close() }
})

test('ENG-020 reads only the persisted matched inbound timeline entry as escaped text', async ({ browser }) => {
  const { context, page } = await composer(browser)
  try {
    const timeline = page.getByRole('region', { name: 'Mail timeline' })
    await expect(timeline).toContainText('Persisted matched reply')
    await expect(timeline).toContainText('window.bad = true Persisted inbound timeline body')
    await expect(timeline).toContainText('cv.pdf')
    await expect(timeline).not.toContainText('fixture-unrelated-message')
    await expect(page.locator('script:text("window.bad")')).toHaveCount(0)
  } finally { await context.close() }
})

test('ENG-020 clears a prior lead timeline before showing the newly selected lead', async ({ browser }) => {
  const { context, page } = await composer(browser)
  try {
    const timeline = page.getByRole('region', { name: 'Mail timeline' })
    await expect(timeline).toContainText('Persisted matched reply')
    const loadedSecondTimeline = page.waitForResponse((response) => response.url().includes('/api/mail-threads/lead/') && response.status() === 200)
    await page.getByRole('button', { name: /Timeline switch lead/ }).click()
    await loadedSecondTimeline
    await expect(timeline).toContainText('No matched mail in this conversation yet.')
    await expect(timeline).not.toContainText('Persisted matched reply')
  } finally { await context.close() }
})

test('ENG-033 an ambiguous send does not offer a repeat send or reuse its confirmation', async ({ browser }) => {
  const { context, reply, requests } = await composer(browser, true)
  try {
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    await expect(reply.getByRole('status')).toContainText('Delivery could not be confirmed')
    await expect(reply.getByRole('button')).toHaveCount(0)
    expect(requests).toEqual(['prepare', 'authorize', 'send'])
  } finally { await context.close() }
})
