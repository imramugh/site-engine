import { describe, expect, it } from 'vitest'
import { canTransitionLead, csvEscape, validateInquiry } from '../src/inquiries'

const valid = { email: 'visitor@example.test', message: 'Please contact me about a project.', topic: 'project', sourcePage: '/contact', consent: true, idempotencyKey: 'a-valid-idempotency-key-1234' }

describe('ENG-019 inquiry validation and lead transitions', () => {
  it('requires valid email, consent, safe source, and a bounded message', () => {
    expect(validateInquiry(valid).input).toMatchObject({ email: 'visitor@example.test', topic: 'project' })
    const invalid = validateInquiry({ ...valid, email: 'not-an-email', consent: false, sourcePage: 'https://example.test', message: '' })
    expect(invalid.input).toBeUndefined()
    expect(invalid.errors).toMatchObject({ email: expect.any(String), consent: expect.any(String), sourcePage: expect.any(String), message: expect.any(String) })
  })

  it('accepts omitted legacy names but rejects a provided blank or unsafe name', () => {
    expect(validateInquiry(valid).input?.name).toBeUndefined()
    expect(validateInquiry({ ...valid, name: null }).input?.name).toBeUndefined()
    expect(validateInquiry({ ...valid, name: '' }).input?.name).toBeUndefined()
    expect(validateInquiry({ ...valid, name: '  ' }).errors.name).toMatch(/name/i)
    expect(validateInquiry({ ...valid, name: 'Visitor\u0000' }).errors.name).toMatch(/name/i)
    expect(validateInquiry({ ...valid, name: '  Synthetic visitor  ', telephone: '  +1 555 0123 ', company: '  Example Company  ' }).input).toMatchObject({ name: 'Synthetic visitor', telephone: '+1 555 0123', company: 'Example Company' })
  })

  it('allows only the lead lifecycle transitions', () => {
    expect(canTransitionLead('new', 'qualified')).toBe(true)
    expect(canTransitionLead('proposal', 'won')).toBe(true)
    expect(canTransitionLead('won', 'contacted')).toBe(false)
    expect(canTransitionLead('lost', 'new')).toBe(false)
  })

  it('escapes CSV fields and neutralizes spreadsheet formulas', () => {
    expect(csvEscape('said "hello", then left')).toBe('"said ""hello"", then left"')
    expect(csvEscape('=HYPERLINK("https://example.test")')).toBe('"\'=HYPERLINK(""https://example.test"")"')
    expect(csvEscape('\t =SUM(1,1)')).toBe('"\'\t =SUM(1,1)"')
    expect(csvEscape('\u001f@cmd')).toBe('"\'\u001f@cmd"')
    expect(csvEscape('\ufeff=SUM(1,1)')).toBe('"\'\ufeff=SUM(1,1)"')
  })
})
