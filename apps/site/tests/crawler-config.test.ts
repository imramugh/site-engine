import { describe, expect, it } from 'vitest'
import { robotsText } from '../src/lib/crawler-config.js'

const sitemap = 'https://public.example.test/sitemap.xml'
const protectedPaths = ['/admin/', '/preview/', '/api/', '/oauth/', '/mcp/']

function group(text: string, agent: string): string {
  const start = text.indexOf(`User-agent: ${agent}`)
  if (start < 0) return ''
  const next = text.indexOf('\n\n', start)
  return text.slice(start, next < 0 ? undefined : next)
}

describe('reviewed crawler policy', () => {
  for (const searchEngines of [false, true]) for (const aiSearchAndAnswers of [false, true]) for (const aiModelTraining of [false, true]) {
    it(`renders search=${searchEngines} answers=${aiSearchAndAnswers} training=${aiModelTraining}`, () => {
      const text = robotsText('public', sitemap, { searchEngines, aiSearchAndAnswers, aiModelTraining })
      expect(group(text, '*')).toContain(searchEngines ? 'Allow: /' : 'Disallow: /')
      for (const agent of ['OAI-SearchBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot']) {
        const rules = group(text, agent)
        expect(rules).toContain(aiSearchAndAnswers ? 'Allow: /' : 'Disallow: /')
        if (aiSearchAndAnswers) for (const path of protectedPaths) expect(rules).toContain(`Disallow: ${path}`)
      }
      for (const agent of ['GPTBot', 'ClaudeBot', 'Google-Extended']) {
        const rules = group(text, agent)
        expect(rules).toContain(aiModelTraining ? 'Allow: /' : 'Disallow: /')
        if (aiModelTraining) for (const path of protectedPaths) expect(rules).toContain(`Disallow: ${path}`)
      }
      expect(text).not.toContain('ChatGPT-User')
      expect(text).not.toContain('Perplexity-User')
      expect(text).toContain(`Sitemap: ${sitemap}`)
    })
  }

  it('keeps legacy public snapshots permissive and mounted previews unconditionally closed', () => {
    expect(group(robotsText('public', sitemap), '*')).toContain('Allow: /')
    const preview = robotsText('preview', sitemap, { searchEngines: true, aiSearchAndAnswers: true, aiModelTraining: true })
    expect(preview).toContain('User-agent: *\nDisallow: /')
    expect(preview).not.toContain('OAI-SearchBot')
    expect(preview).not.toContain('Sitemap:')
  })
})
