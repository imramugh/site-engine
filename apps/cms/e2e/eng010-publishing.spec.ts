import { expect, test } from '@playwright/test'
import { readyAndApprove, reviewer } from './eng010-publishing.fixture'

test('ENG-010 publishes an approved snapshot, retains it after terminal failure, and alerts its Owner', async ({ browser }) => {
  const session = await reviewer(browser)
  try {
    const publishedSet = await readyAndApprove(session.page)
    const published = await session.page.request.post(`/__e2e/eng010-publish/success?changeSet=${publishedSet}`)
    expect(published.status(), await published.text()).toBe(200)
    const completed = await published.json() as { claim: { id: string; changeSetID: string; contentHash: string }; health: { contentHash: string } }
    expect(completed).toMatchObject({ claim: { changeSetID: publishedSet }, job: { status: 'completed' }, stages: expect.arrayContaining(['dispatched', 'building', 'built', 'activating']), served: expect.stringContaining('Original review heading') })
    expect(completed.health.contentHash).toBe(completed.claim.contentHash)
    const failedSet = await readyAndApprove(session.page)
    const before = await session.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
    const failed = await session.page.request.post(`/__e2e/eng010-publish/fail?changeSet=${failedSet}&cleanup=${completed.claim.id}`)
    expect(failed.status(), await failed.text()).toBe(200)
    const body = await failed.json() as { claim: { changeSetID: string; id: string }; notification: { sourceID: string }; smtp: string | null }
    expect(body).toMatchObject({ claim: { changeSetID: failedSet }, job: { status: 'failed' }, releases: before.releaseCount, served: expect.stringContaining('Original review heading'), notification: { sourceID: body.claim.id, state: 'queued' }, smtp: expect.stringContaining('Publish build failed') })
    expect(body.smtp).toContain(`publish=${body.claim.id}`)
  } finally { await session.context.close() }
})
