import { describe, expect, it } from 'vitest'
import { defaultRetentionPolicy, retentionEligible } from '../src/retention'

describe('ENG-037 retention boundaries', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  it('keeps defaults explicit and retains manual personal classes', () => {
    expect(defaultRetentionPolicy).toEqual({ spamDays: 30, mediaBinDays: 30, retainedInquiries: 'manual', applicationsAndResumes: 'manual' })
  })
  it('purges exactly at, but not before, the controlled 30-day boundary', () => {
    expect(retentionEligible('2026-09-05T12:00:00.000Z', now)).toBe(true)
    expect(retentionEligible('2026-09-05T12:00:00.001Z', now)).toBe(false)
    expect(retentionEligible(undefined, now)).toBe(false)
    expect(retentionEligible('not-a-date', now)).toBe(false)
  })
})
