import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

test('ENG-022 dashboard exposes authorized work queues and useful actions on desktop and mobile', async ({ browser }) => {
  for (const role of ['owner', 'sales', 'hiring'] as const) {
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
    const token = role === 'owner' ? 'synthetic-operations-owner-session-token' : `synthetic-application-${role}-session-token`
    await context.addCookies(['site_engine_session','__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
    const page = await context.newPage()
    for (const width of [1440,390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto('/admin')
      await expect(page.locator('[data-dashboard-greeting] h2')).toHaveText(/Good (morning|afternoon|evening)/)
      await expect(page.locator('[data-dashboard-metric]')).toHaveCount(4)
      for (const hook of ['reviews','issues','leads','site-status']) await expect(page.locator(`[data-dashboard-${hook}]`)).toBeVisible()
      if (role === 'owner') {
        await expect(page.getByRole('link', { name: '+ New page', exact: true })).toHaveAttribute('href','/content-editor/new')
        await expect(page.getByRole('link', { name: 'Upload media', exact: true })).toHaveAttribute('href','/media')
        await expect(page.getByRole('link', { name: 'Connect an assistant', exact: true })).toHaveAttribute('href', '/integrations?tab=assistants')
        const status = page.locator('[data-dashboard-site-status]')
        await expect(status).toContainText('Email delivery')
        await expect(status).toContainText('Not configured')
        await expect(page.locator('[data-dashboard-metric="reviews"]')).toContainText('1 stale change set needs updating')
        await expect(page.locator('[data-dashboard-reviews] [data-dashboard-stale]')).toHaveText('1 stale')
        await expect(page.locator('[data-dashboard-reviews]').getByRole('link', { name: 'All reviews', exact: true })).toHaveAttribute('href', '/editorial')
        await expect(page.locator('[data-dashboard-metric="publish"]')).toContainText('Failed')
        await expect(status.getByText('Latest release', { exact: true }).locator('..')).toContainText('Publish failed · 57')
        await expect(status.getByText('AI providers', { exact: true }).locator('..')).toContainText('1 needs attention')
      } else await expect(page.locator('[data-dashboard-actions]')).toHaveCount(0)
      if (role === 'hiring') await expect(page.locator('[data-dashboard-leads]')).toContainText('not available for this role')
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false)
      await page.addScriptTag({path:axeSource})
      expect(await page.evaluate(async()=> (await (window as unknown as {axe:typeof import('axe-core')}).axe.run('main')).violations)).toEqual([])
    }
    await context.close()
  }
})
