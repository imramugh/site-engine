import { describe, expect, it } from 'vitest'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { buildSearchIndex } from '../src/search.js'

describe('ENG-024 static search index', () => {
  it('uses reachable published pages and visible approved text only', () => {
    const snapshot = structuredClone(neutralFixture)
    const home = snapshot.pages[0]!
    const hero = home.blocks[0]!
    if (hero.type === 'hero') hero.body = 'Published search phrase'
    home.blocks.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'callout', heading: 'Hidden heading', body: 'hidden search phrase', hidden: true, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } })
    snapshot.pages.push({ ...home, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'draft', title: 'Draft title', summary: 'draft search phrase', status: 'draft' })
    const index = buildSearchIndex(snapshot)
    expect(JSON.stringify(index)).toContain('Published search phrase')
    expect(JSON.stringify(index)).not.toContain('hidden search phrase')
    expect(JSON.stringify(index)).not.toContain('draft search phrase')
  })
})
