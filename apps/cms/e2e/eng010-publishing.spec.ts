import { expect, test } from '@playwright/test'
import { readyAndApprove, reviewer } from './eng010-publishing.fixture'

test('ENG-010 approves content then sends its immutable claim through the signed receiver to a completed public release', async ({ browser }) => {
  const session = await reviewer(browser)
  await readyAndApprove(session.page)
  const result = await session.page.request.post('/__e2e/eng010-publish/success')
  expect(result.status(), await result.text()).toBe(200)
  await expect(result.json()).resolves.toMatchObject({ job: { status: 'completed' }, releases: expect.any(Number), stages: expect.arrayContaining(['dispatched', 'building', 'built', 'activating']), served: expect.stringContaining('Original review heading') })
  await session.context.close()
})

test('ENG-010 retains the completed release when a later signed build fails and queues an Owner alert', async ({ browser }) => {
  const session = await reviewer(browser)
  await readyAndApprove(session.page)
  const before = await session.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
  const result = await session.page.request.post('/__e2e/eng010-publish/fail')
  expect(result.status(), await result.text()).toBe(200)
  await expect(result.json()).resolves.toMatchObject({ job: { status: 'failed' }, releases: before.releaseCount, served: expect.stringContaining('Original review heading'), smtp: expect.stringContaining('Publish build failed') })
  await session.context.close()
})
