import { describe, expect, it } from 'vitest'
import { providerCapabilities, runAIJob } from '../src/ai-providers'
const configs = () => new Map([['openai', { credential: 'one', monthlyCap: 10, used: 0 }], ['anthropic', { credential: 'two', monthlyCap: 10, used: 0 }]])
describe('ENG-023 provider job seam', () => {
  it('declares official adapter endpoints without contacting them and falls back through injected transport', async () => {
    expect(providerCapabilities.openai.endpoint).toBe('https://api.openai.com/v1/responses')
    const calls: string[] = []; const result = await runAIJob({ provider: 'openai', fallbackProvider: 'anthropic', model: 'synthetic', estimatedCost: 1 }, configs(), async ({ provider }) => { calls.push(provider); return { ok: provider === 'anthropic' } })
    expect(result).toEqual({ provider: 'anthropic', fallbackUsed: true }); expect(calls).toEqual(['openai', 'anthropic'])
  })
  it('enforces configured caps before transport', async () => {
    const calls: string[] = []; await expect(runAIJob({ provider: 'openai', model: 'synthetic', estimatedCost: 11 }, configs(), async ({ provider }) => { calls.push(provider); return { ok: true } })).rejects.toThrow('AI_JOB_UNAVAILABLE'); expect(calls).toEqual([])
  })
})
