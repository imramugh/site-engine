import { describe, expect, it } from 'vitest'
import { LeadFilterError, leadFilterClauses, parseLeadFilters } from '../src/lead-filters'

describe('lead filters', () => {
  it('parses source and received range into shared list, pipeline, and export clauses', () => {
    const filters = parseLeadFilters(new URL('https://cms.test/api/leads?stage=proposal&urgent=true&sourcePage=%2Fservices%2Fa&received=90&page=2'))
    expect(filters).toEqual({ stage: 'proposal', urgent: true, sourcePage: '/services/a', received: '90', page: 2 })
    expect(leadFilterClauses(filters, true, new Date('2026-10-04T12:00:00.000Z'))).toEqual([
      { stage: { equals: 'proposal' } },
      { urgent: { equals: true } },
      { sourcePage: { equals: '/services/a' } },
      { createdAt: { greater_than_equal: '2026-07-06T12:00:00.000Z' } },
    ])
    expect(leadFilterClauses(filters, false, new Date('2026-10-04T12:00:00.000Z'))).not.toContainEqual({ stage: { equals: 'proposal' } })
  })

  it.each([
    ['stage=maybe', 'valid lead stage'],
    ['urgent=yes', 'true or false'],
    ['sourcePage=https%3A%2F%2Fevil.test', 'valid source page'],
    ['received=quarter', 'last 7, 30, 90, or 365 days'],
    ['page=0', 'positive whole number'],
  ])('rejects invalid query %s with useful guidance', (query, guidance) => {
    expect(() => parseLeadFilters(new URL(`https://cms.test/api/leads?${query}`))).toThrowError(new RegExp(guidance))
    expect(() => parseLeadFilters(new URL(`https://cms.test/api/leads?${query}`))).toThrow(LeadFilterError)
  })
})
