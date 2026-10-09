import { expect, test, type Browser } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

async function owner(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-operations-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

test('ENG-022 browser flow keeps urgent delivery after a routine preference is muted and sends a minimal outage alert', async ({ browser }) => {
  const session = await owner(browser)
  try {
    await session.page.goto('/account')
    const preferences = session.page.getByRole('region', { name: 'Your notification emails' })
    const routine = preferences.getByRole('checkbox', { name: 'New leads' })
    await expect(routine).toBeChecked()
    await routine.uncheck()
    const saved = session.page.waitForResponse(response => response.url().endsWith('/api/notification-user-preferences') && response.request().method() === 'PUT')
    await preferences.getByRole('button', { name: 'Save preferences' }).click()
    expect((await saved).status()).toBe(200)
    await expect(preferences.getByRole('status')).toContainText('Notification preferences saved')

    const response = await session.page.request.post('/__e2e/eng022-notifications')
    expect(response.status(), await response.text()).toBe(200)
    const result = await response.json() as { integration: { state: string; ownerDelivered: boolean; minimal: boolean; adminURL: string }; urgent: { state: string; ownerDelivered: boolean; minimal: boolean } }
    expect(result.integration, JSON.stringify(result)).toMatchObject({ state: 'delivered', ownerDelivered: true, minimal: true })
    expect(result.urgent).toMatchObject({ state: 'delivered', ownerDelivered: true, minimal: true })
    await session.page.goto(result.integration.adminURL)
    await expect(session.page.getByRole('heading', { name: 'Change log' })).toBeVisible()
    const anonymous = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
    const anonymousPage = await anonymous.newPage()
    await anonymousPage.goto(result.integration.adminURL)
    await expect(anonymousPage.getByText('Owner access is required to view the change log.')).toBeVisible()
    expect((await anonymous.request.get('/api/operations')).status()).toBe(403)
    await anonymous.close()
  } finally {
    await session.context.close()
  }
})
