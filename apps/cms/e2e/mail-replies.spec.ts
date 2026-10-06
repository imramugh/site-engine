import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const mcpStructured = <T>(result: unknown) => ((result as { structuredContent?: T; toolResult?: { structuredContent?: T } }).structuredContent ?? (result as { toolResult?: { structuredContent?: T } }).toolResult?.structuredContent) as T
const mcpResult = <T>(result: unknown) => mcpStructured<T>(result) ?? JSON.parse(((result as { content?: Array<{ text?: string }>; toolResult?: { content?: Array<{ text?: string }> } }).content ?? (result as { toolResult?: { content?: Array<{ text?: string }> } }).toolResult?.content)?.find(item => item.text)?.text ?? '{}') as T

async function composer(browser: Browser, sendFails = false, threads: Array<{ id: string; subject: string }> = [], prepare = true) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  const requests: string[] = []
  await page.route('**/api/mail-replies/lead/**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { senders: [{ address: 'team@example.test', label: 'Team mailbox' }], threads, canAuthorize: true } })
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
  if (prepare) {
    await reply.getByLabel('Reply subject').fill('  Exact subject  ')
    await reply.getByLabel('Reply message').fill('  Exact body  ')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
  }
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
    await expect(timeline.getByRole('link', { name: 'cv.pdf' })).toHaveAttribute('href', /\/api\/mail-attachments\/lead\/[0-9a-f-]+\/0$/)
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

test('ENG-020 selects only a scoped provider conversation before explicit confirmation', async ({ browser }) => {
  const threads = [{ id: 'provider-thread-a', subject: 'Thread A' }, { id: 'provider-thread-b', subject: 'Thread B' }]
  const { context, reply, requests, page } = await composer(browser, false, threads, false)
  try {
    await expect(reply.getByLabel('Existing conversation')).toHaveValue('provider-thread-a')
    await reply.getByLabel('Existing conversation').selectOption('provider-thread-b')
    await expect(reply.getByLabel('Reply subject')).toHaveValue('Thread B')
    await reply.getByLabel('Reply message').fill('Approved body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    expect(requests).toEqual(['prepare'])
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    expect(requests).toEqual(['prepare', 'authorize', 'send'])
    await expect(page.getByRole('option', { name: /unrelated/i })).toHaveCount(0)
  } finally { await context.close() }
})

test('ENG-020 real handler grounds the selected OAuth conversation before sending', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    await page.request.post(`${origin}/__e2e/mail-reply-fixture`)
    await page.goto('/leads')
    await page.getByRole('button', { name: /First editable lead/ }).click()
    const reply = page.locator('[data-mail-reply-composer]')
    await expect(reply.getByLabel('Existing conversation')).toHaveCount(1)
    await expect(reply.getByLabel('Existing conversation').getByRole('option')).toHaveCount(3)
    await reply.getByLabel('Existing conversation').selectOption('fixture-oauth-thread-b')
    await reply.getByLabel('Reply message').fill('Approved fixture body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await expect(page.request.get(`${origin}/__e2e/mail-reply-deliveries`).then(response => response.json())).resolves.toEqual({ deliveries: [] })
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    const evidence = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: Array<{ threadID: string; mime: string }> }
    expect(evidence.deliveries).toHaveLength(1)
    expect(evidence.deliveries[0]).toMatchObject({ threadID: 'fixture-oauth-thread-b' })
    expect(evidence.deliveries[0].mime).toContain('Subject: Fixture OAuth reply B\r\n')
    expect(evidence.deliveries[0].mime).toContain('Approved fixture body')
  } finally { await context.close() }
})

test('ENG-020 sends a confirmed initial OAuth message through the real handler', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    await page.request.post(`${origin}/__e2e/mail-reply-fixture`)
    const before = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: Array<{ threadID: string; mime: string }> }
    await page.goto('/leads')
    await page.getByRole('button', { name: /First editable lead/ }).click()
    const reply = page.locator('[data-mail-reply-composer]')
    await reply.getByLabel('Existing conversation').selectOption('')
    await expect(reply.getByLabel('Existing conversation')).toHaveValue('')
    await reply.getByLabel('Reply subject').fill('Initial approved subject')
    await reply.getByLabel('Reply message').fill('Initial approved body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    const evidence = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: Array<{ threadID: string; mime: string }> }
    expect(evidence.deliveries).toHaveLength(before.deliveries.length + 1)
    const delivered = evidence.deliveries.at(-1)!
    expect(delivered.threadID).toBe('fixture-new-thread')
    expect(delivered.mime).toContain('Subject: Initial approved subject\r\n')
    expect(delivered.mime).toContain('Initial approved body')
    expect(delivered.mime).toContain('Message-ID: <')
    expect(delivered.mime).not.toContain('In-Reply-To:')
  } finally { await context.close() }
})

test('ENG-020 clears delayed reply state when switching records', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  let optionLoads = 0
  await page.route('**/api/mail-replies/lead/**', async route => {
    if (route.request().method() === 'GET') {
      optionLoads += 1
      return route.fulfill({ json: { senders: [{ address: optionLoads === 1 ? 'first@example.test' : 'second@example.test', label: 'Scoped mailbox' }], threads: [], canAuthorize: true } })
    }
    const body = route.request().postDataJSON()
    if (body.action === 'prepare') {
      await new Promise(resolve => setTimeout(resolve, 300))
      return route.fulfill({ json: { draft: { id: '11111111-1111-4111-8111-111111111111', sender: 'first@example.test', recipient: 'notes-a.synthetic@example.test', subject: 'Old subject', body: 'Old body' } } })
    }
    return route.fulfill({ json: { authorization: { id: '22222222-2222-4222-8222-222222222222' } } })
  })
  try {
    await page.goto('/leads')
    await page.getByRole('button', { name: /First editable lead/ }).click()
    const firstReply = page.locator('[data-mail-reply-composer]')
    await expect(firstReply.getByLabel('Reply sender')).toHaveValue('first@example.test')
    await firstReply.getByLabel('Reply subject').fill('Old subject')
    await firstReply.getByLabel('Reply message').fill('Old body')
    await firstReply.getByRole('button', { name: 'Prepare reply' }).click()
    await page.getByRole('button', { name: /Timeline switch lead/ }).click()
    const secondReply = page.locator('[data-mail-reply-composer]')
    await expect(secondReply.getByLabel('Reply sender')).toHaveValue('second@example.test')
    await expect(secondReply.getByRole('region', { name: 'Exact reply review' })).toHaveCount(0)
    await expect(secondReply.getByRole('status')).toHaveCount(0)
    await expect(secondReply.getByLabel('Reply subject')).toHaveValue('')
    await expect(secondReply.getByLabel('Reply message')).toHaveValue('')
  } finally { await context.close() }
})

test('ENG-020 adopts a persisted same-address conversation only after an explicit action', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    const fixture = await (await page.request.post(`${origin}/__e2e/mail-reply-fixture`)).json() as { adoptionLead: string; adoptionLeadName: string }
    const suggestions = await (await page.request.get(`${origin}/api/mail-suggestions/lead/${fixture.adoptionLead}`)).json() as { suggestions: Array<{ id: string }> }
    expect(suggestions.suggestions).toHaveLength(1)
    await page.goto('/leads'); await page.getByRole('button', { name: fixture.adoptionLeadName }).click()
    const timeline = page.getByRole('region', { name: 'Mail timeline' })
    const adopt = timeline.getByRole('button', { name: 'Adopt conversation' })
    await expect(adopt).toHaveCount(1)
    const before = await adopt.count()
    expect(before).toBeGreaterThan(0)
    await expect(timeline).not.toContainText('Hidden unmatched subject')
    await adopt.first().click()
    await expect(timeline.getByRole('button', { name: 'Adopt conversation' })).toHaveCount(before - 1)
  } finally { await context.close() }
})


test('ENG-020 displays an assistant-prepared envelope, retains it for editing, and requires a new confirmation before one send', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    const fixture = await page.request.post(`${origin}/__e2e/mail-reply-fixture?prepared=1`)
    expect(fixture.ok()).toBe(true)
    expect((await fixture.json() as { preparedDraft?: string }).preparedDraft).toEqual(expect.any(String))
    const before = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: unknown[] }
    await page.goto('/leads')
    await page.getByRole('button', { name: /First editable lead/ }).click()
    const reply = page.locator('[data-mail-reply-composer]')
    const review = reply.getByRole('region', { name: 'Exact reply review' })
    await expect(review).toContainText('Fixture OAuth reply B')
    await expect(review).toContainText('MCP prepared exact body')
    expect((await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: unknown[] }).deliveries).toHaveLength(before.deliveries.length)
    await reply.getByRole('button', { name: 'Edit reply' }).click()
    await expect(reply.getByLabel('Reply sender')).toHaveValue('fixture-reply@example.test')
    await expect(reply.getByLabel('Existing conversation')).toHaveValue('fixture-oauth-thread-b')
    await expect(reply.getByLabel('Reply subject')).toHaveValue('Fixture OAuth reply B')
    await expect(reply.getByLabel('Reply message')).toHaveValue('MCP prepared exact body')
    await reply.getByLabel('Reply message').fill('Edited MCP prepared body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await expect(review).toContainText('Edited MCP prepared body')
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toHaveCount(0)
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    await expect(reply.getByRole('status')).toHaveText('Reply sent.')
    const after = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: Array<{ threadID: string; mime: string }> }
    expect(after.deliveries).toHaveLength(before.deliveries.length + 1)
    expect(after.deliveries.at(-1)).toMatchObject({ threadID: 'fixture-oauth-thread-b' })
    expect(after.deliveries.at(-1)?.mime).toContain('Subject: Fixture OAuth reply B\r\n')
    expect(after.deliveries.at(-1)?.mime).toContain('Edited MCP prepared body')
  } finally { await context.close() }
})

test('ENG-033 opens an assistant deep link beyond the first lead page and lets the real browser session confirm its exact envelope', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    const fixture = await (await page.request.post(`${origin}/__e2e/mail-reply-fixture?prepared=1&deep=1`)).json() as { deepLead: string; deepLeadName: string; preparedDraft: string }
    expect(fixture).toMatchObject({ deepLead: expect.any(String), preparedDraft: expect.any(String) })
    await page.goto(`/leads?lead=${encodeURIComponent(fixture.deepLead)}&draft=${encodeURIComponent(fixture.preparedDraft)}`)
    const detail = page.getByRole('complementary', { name: 'Lead details' })
    await expect(detail).toContainText(fixture.deepLeadName)
    const reply = page.locator('[data-mail-reply-composer]')
    const review = reply.getByRole('region', { name: 'Exact reply review' })
    await expect(review).toContainText('prepared by a connected assistant')
    await expect(review).toContainText('Fixture OAuth reply B')
    await expect(review).toContainText('MCP prepared exact body')
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await expect(reply.getByRole('status')).toContainText('Return to the connected assistant to send')
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toHaveCount(0)
  } finally { await context.close() }
})

test('ENG-033 joins SDK preparation, browser confirmation, and one bound SDK delivery', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-lead-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  let transport: StreamableHTTPClientTransport | undefined
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  try {
    const fixture = await (await page.request.post(`${origin}/__e2e/mail-reply-fixture?deep=1`)).json() as { deepLead: string }
    const identity = await (await page.request.post(`${origin}/__e2e/mcp-identity`)).json() as { bearer: string }
    const client = new Client({ name: 'e2e-bound-mail', version: '1.0.0' })
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${identity.bearer}` } } })
    await client.connect(transport)
    const prepared = await client.callTool({ name: 'prepare_reply', arguments: { target: 'lead', id: fixture.deepLead, sender: 'fixture-reply@example.test', subject: 'SDK joined subject', body: 'SDK joined body' } }) as unknown as { structuredContent: { draft: { id: string; confirmationURL: string } } }
    const draft = mcpStructured<{ draft: { id: string; confirmationURL: string } }>(prepared).draft
    await page.goto(new URL(draft.confirmationURL).pathname + new URL(draft.confirmationURL).search)
    const reply = page.locator('[data-mail-reply-composer]')
    await expect(reply.getByRole('region', { name: 'Exact reply review' })).toContainText('SDK joined body')
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    const status = await client.callTool({ name: 'get_reply_status', arguments: { draftID: draft.id } })
    const grantID = mcpStructured<{ grantID: string }>(status).grantID
    const sent = await client.callTool({ name: 'send_reply', arguments: { draftID: draft.id, grantID } })
    expect(mcpResult<{ messageID: string }>(sent).messageID).toEqual(expect.any(String))
    const deliveries = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: unknown[] }
    expect(deliveries.deliveries).toHaveLength(1)
    await expect(client.callTool({ name: 'send_reply', arguments: { draftID: draft.id, grantID } })).rejects.toThrow()
  } finally { await transport?.close().catch(() => undefined); if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls; await context.close() }
})

test('ENG-033 lets a fresh Sales user confirm and cancel a lead reply through the real handler', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-application-sales-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    await page.request.post(`${origin}/__e2e/mail-reply-fixture`)
    await page.goto('/leads')
    await page.getByRole('button', { name: /First editable lead/ }).click()
    const reply = page.locator('[data-mail-reply-composer]')
    await reply.getByLabel('Reply subject').fill('Sales-confirmed reply')
    await reply.getByLabel('Reply message').fill('Sales exact body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toBeVisible()
    await reply.getByRole('button', { name: 'Cancel confirmation and edit' }).click()
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toHaveCount(0)
  } finally { await context.close() }
})

test('ENG-033 lets a fresh Hiring user cancel then send one confirmed application reply through the real handler', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-application-hiring-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  try {
    await page.request.post(`${origin}/__e2e/mail-reply-fixture`)
    const before = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: unknown[] }
    await page.goto('/applications')
    await page.getByRole('button', { name: /^Applications/ }).click()
    await page.getByRole('button', { name: /Synthetic candidate/ }).click()
    const reply = page.locator('[data-mail-reply-composer]')
    await expect(reply.getByLabel('Existing conversation')).toHaveValue('fixture-oauth-application-thread')
    await reply.getByLabel('Reply message').fill('Canceled hiring body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Cancel confirmation and edit' }).click()
    await expect(reply.getByRole('button', { name: 'Send confirmed reply' })).toHaveCount(0)
    await reply.getByLabel('Reply message').fill('Confirmed hiring body')
    await reply.getByRole('button', { name: 'Prepare reply' }).click()
    await reply.getByRole('button', { name: 'Confirm exact reply' }).click()
    await reply.getByRole('button', { name: 'Send confirmed reply' }).click()
    await expect(reply.getByRole('status')).toHaveText('Reply sent.')
    const after = await (await page.request.get(`${origin}/__e2e/mail-reply-deliveries`)).json() as { deliveries: Array<{ threadID: string; mime: string }> }
    expect(after.deliveries).toHaveLength(before.deliveries.length + 1)
    expect(after.deliveries.at(-1)).toMatchObject({ threadID: 'fixture-oauth-application-thread' })
    expect(after.deliveries.at(-1)?.mime).toContain('Subject: Fixture hiring reply\r\n')
    expect(after.deliveries.at(-1)?.mime).toContain('Confirmed hiring body')
  } finally { await context.close() }
})
