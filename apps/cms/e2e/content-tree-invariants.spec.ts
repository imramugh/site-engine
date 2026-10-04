import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

test('ENG-003 refuses disallowed services templates and reports every incompatible conversion block', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-operations-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  await page.goto('/content-tree')
  await expect(page.getByRole('heading', { name: 'Content' })).toBeVisible()
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])

  const result = await page.evaluate(async () => {
    const headers = { 'content-type': 'application/json' }
    const sectionResponse = await fetch('/api/sections', { method: 'POST', headers, body: JSON.stringify({
      name: 'Services browser section',
      summary: 'A synthetic services-like section for browser-level template policy validation.',
      slug: `services-browser-${crypto.randomUUID()}`,
      allowedTemplates: ['landing', 'pillar', 'service', 'standard'],
    }) })
    const section = await sectionResponse.json() as { doc?: { id: string } }
    if (!section.doc) return { sectionStatus: sectionResponse.status, section }
    const articleResponse = await fetch('/api/pages', { method: 'POST', headers, body: JSON.stringify({
      title: 'Rejected article in services',
      summary: 'A synthetic browser scenario proving the services policy rejects article templates.',
      slug: `services-article-${crypto.randomUUID()}`,
      sectionId: section.doc.id,
      template: 'article',
      blocks: [],
    }) })
    const article = await articleResponse.json() as { errors?: Array<{ data?: { errors?: Array<{ path?: string; message?: string }> } }> }
    const blocks = [
      { id: crypto.randomUUID(), type: 'hero', heading: 'Existing hero', body: 'This block must be removed or converted before using the article template.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } },
      { id: crypto.randomUUID(), type: 'contact', heading: 'Existing contact', body: 'This block is also incompatible with the article template.', inquiryForm: false, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } },
    ]
    const createdResponse = await fetch('/api/pages', { method: 'POST', headers, body: JSON.stringify({
      title: 'Conversion browser page',
      summary: 'A synthetic draft that proves incompatible blocks are all reported before template conversion.',
      slug: `conversion-browser-${crypto.randomUUID()}`,
      sectionId: section.doc.id,
      template: 'standard',
      blocks,
    }) })
    const created = await createdResponse.json() as { doc?: { id: string } }
    if (!created.doc) return { sectionStatus: sectionResponse.status, articleStatus: articleResponse.status, article, createdStatus: createdResponse.status, created }
    const rejectedResponse = await fetch(`/api/pages/${created.doc.id}?draft=true`, { method: 'PATCH', headers, body: JSON.stringify({ template: 'article' }) })
    const rejected = await rejectedResponse.json() as { errors?: Array<{ data?: { errors?: Array<{ path?: string; message?: string }> } }> }
    const persistedResponse = await fetch(`/api/pages/${created.doc.id}?draft=true`)
    const persisted = await persistedResponse.json() as { template?: string; blocks?: unknown[] }
    return { sectionStatus: sectionResponse.status, articleStatus: articleResponse.status, article, createdStatus: createdResponse.status, rejectedStatus: rejectedResponse.status, rejected, persistedStatus: persistedResponse.status, persisted }
  })

  expect(result.sectionStatus).toBe(201)
  expect(result.articleStatus).toBe(400)
  expect(result.article?.errors?.flatMap((error) => error.data?.errors ?? [])).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'template', message: expect.stringContaining('not allowed') })]))
  expect(result.createdStatus).toBe(201)
  expect(result.rejectedStatus).toBe(400)
  expect(result.rejected?.errors?.flatMap((error) => error.data?.errors ?? [])).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'blocks.0.type', message: expect.stringContaining('hero') }),
    expect.objectContaining({ path: 'blocks.1.type', message: expect.stringContaining('contact') }),
  ]))
  expect(result.persistedStatus).toBe(200)
  expect(result.persisted).toMatchObject({ template: 'standard' })
  expect(result.persisted?.blocks).toHaveLength(2)
  await context.close()
})
