import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('public inquiry survives retries and enters the protected staff workflow', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000)
  const origin = baseURL!
  const headers = { origin }
  const visitor = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const input = { name: 'Synthetic visitor', email: 'http-visitor@example.test', message: '<script>literal inquiry text</script> Please help.', topic: 'active-incident', sourcePage: '/contact', consent: true, telephone: '+1 555 0123', company: 'Example Company', idempotencyKey: randomUUID() }
  try {
    expect((await visitor.request.post('/api/inquiries', { headers, data: { ...input, consent: false } })).status()).toBe(422)
    const accepted = await visitor.request.post('/api/inquiries', { headers, data: input })
    expect(accepted.status()).toBe(201)
    const { id } = await accepted.json()
    const replay = await visitor.request.post('/api/inquiries', { headers, data: input })
    expect(replay.status()).toBe(200)
    expect((await replay.json()).id).toBe(id)
    const legacy = await visitor.request.post('/api/inquiries', { headers, data: { email: 'legacy-http-visitor@example.test', message: 'A compatible legacy inquiry.', topic: 'general', sourcePage: '/contact', consent: true, idempotencyKey: randomUUID() } })
    expect(legacy.status()).toBe(201)
    const legacyID = (await legacy.json()).id as string
    expect((await visitor.request.post('/api/inquiries', { headers, data: { ...input, message: 'Conflicting content' } })).status()).toBe(409)
    expect((await visitor.request.get('/api/leads')).status()).toBe(401)
    expect((await visitor.request.get('/api/inquiries')).status()).toBeGreaterThanOrEqual(400)
    await page.goto('/admin/login')
    await page.locator('#emergency-email').fill('content-owner.synthetic@example.test')
    await page.locator('#emergency-code').fill('synthetic-content-owner-code-05')
    await page.getByTestId('emergency-sign-in').click()
    await page.waitForURL(/\/admin$/)
    const listed = await page.request.get('/api/inquiries')
    expect(listed.status()).toBe(200)
    expect((await listed.json()).docs).toEqual(expect.arrayContaining([expect.objectContaining({ id, urgent: true, stage: 'new' })]))
    await page.goto('/leads')
    await page.locator('[data-lead-card][data-urgent="true"]').filter({ hasText: 'Example Company' }).click()
    await expect(page.getByText(input.message, { exact: true })).toBeVisible()
    const detail = page.getByRole('complementary', { name: 'Lead details' })
    await expect(detail.getByRole('heading', { name: 'Example Company', exact: true })).toBeVisible()
    await expect(detail.getByText('+1 555 0123', { exact: true })).toBeVisible()
    await expect(detail.getByText('http-visitor@example.test', { exact: true })).toBeVisible()
    expect(await page.locator('script').filter({ hasText: 'literal inquiry text' }).count()).toBe(0)
    expect((await page.request.patch(`/api/leads/${id}`, { headers, data: { stage: 'qualified', notes: 'Synthetic review completed.' } })).status()).toBe(200)
    expect((await page.request.patch(`/api/inquiries/${id}`, { headers, data: { stage: 'won' } })).status()).toBeGreaterThanOrEqual(400)
    expect((await page.request.patch(`/api/inquiries/${id}`, { headers, data: { consentBasis: 'staff-recorded' } })).status()).toBeGreaterThanOrEqual(400)
    const exported = await page.request.get('/api/leads/export')
    expect(exported.status()).toBe(200)
    expect(await exported.text()).toContain(input.email)
    for (const createdID of [id, legacyID]) expect((await page.request.delete(`/api/inquiries/${createdID}`, { headers })).status()).toBe(200)
    expect((await (await page.request.get('/api/leads')).json()).leads.some((lead: { id: string }) => lead.id === id)).toBe(false)
  } finally { await visitor.close() }
})
