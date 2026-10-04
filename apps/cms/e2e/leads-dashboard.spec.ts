import { expect, test } from '@playwright/test'

async function localOwner(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('lead-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill('synthetic-lead-owner-code-07')
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin$/)
}

test('ENG-019 staff records, assigns, filters, updates, and exports a manual lead', async ({ page }) => {
  await localOwner(page)
  await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Lead pipeline' })).toBeVisible()
  await page.goto('/leads')
  await page.getByLabel('Email').fill('manual-lead@example.test')
  await page.getByLabel('Name').fill('Manual Lead')
  await page.getByLabel('Message').fill('Staff-recorded lead details are shown as plain text.')
  await page.getByLabel(/I recorded the contact/).check()
  await page.getByRole('button', { name: 'Create manual lead' }).click()
  await expect(page.getByRole('status')).toContainText('staff-recorded consent')
  await page.getByRole('button', { name: /manual-lead@example\.test/ }).click()
  await page.getByLabel('Lead details').getByLabel('Stage').selectOption('qualified')
  await page.getByLabel('Active assignee').selectOption({ label: 'Synthetic Lead Owner' })
  await page.getByLabel('Notes').fill('Called the contact.')
  await page.getByLabel('Next action').fill('Send a scoped proposal.')
  await page.getByRole('button', { name: 'Save lead details' }).click()
  await expect(page.getByRole('status')).toContainText('Lead details saved')
  await page.getByLabel('Lead filters').getByLabel('Stage').selectOption('qualified')
  await expect(page.getByRole('button', { name: /manual-lead@example\.test/ })).toBeVisible()
  const csv = await page.request.get(await page.getByRole('link', { name: 'Export filtered CSV' }).getAttribute('href') ?? '')
  expect(csv.ok()).toBeTruthy(); expect(await csv.text()).toContain('manual-lead@example.test')
})

test('ENG-019 redirects an editor away from the protected lead dashboard', async ({ page }) => {
  await page.goto('/api/auth/google')
  await page.getByRole('button', { name: 'Sign in as Synthetic Editor' }).click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  await page.goto('/leads')
  await page.waitForURL(/\/admin\/login/)
})
