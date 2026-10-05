import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { normalizeApplicantLinkedIn, normalizeApplicantTelephone, preserveApplicationIntake, validateResume } from '../src/applications'

function docx(entries: Record<string, string>) {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0
  for (const [name, value] of Object.entries(entries)) { const source = Buffer.from(value); const body = deflateRawSync(source); const file = Buffer.alloc(30); file.writeUInt32LE(0x04034b50); file.writeUInt16LE(20, 4); file.writeUInt16LE(8, 8); file.writeUInt32LE(body.length, 18); file.writeUInt32LE(source.length, 22); file.writeUInt16LE(Buffer.byteLength(name), 26); const local = Buffer.concat([file, Buffer.from(name), body]); locals.push(local); const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(source.length, 24); directory.writeUInt16LE(Buffer.byteLength(name), 28); directory.writeUInt32LE(offset, 42); central.push(Buffer.concat([directory, Buffer.from(name)])); offset += local.length }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end])
}
const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
describe('application resume validation', () => {
  it('accepts a structured DOCX and rejects ZIP magic alone or a missing document part', () => {
    const valid = docx({ '[Content_Types].xml': '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'word/document.xml': '<w:document xmlns:w="w"/>' })
    expect(() => validateResume({ data: valid, mimetype: type, size: valid.length, name: 'resume.docx' })).not.toThrow()
    expect(() => validateResume({ data: Buffer.from('PK\x03\x04not-a-docx'), mimetype: type, size: 14, name: 'resume.docx' })).toThrow('DOCX')
    const incomplete = docx({ '[Content_Types].xml': '<Types/>' })
    expect(() => validateResume({ data: incomplete, mimetype: type, size: incomplete.length, name: 'resume.docx' })).toThrow('DOCX')
    const macro = docx({ '[Content_Types].xml': '<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>', 'word/document.xml': '<w:document xmlns:w="w"/>', 'word/vbaProject.bin': 'macro' })
    expect(() => validateResume({ data: macro, mimetype: type, size: macro.length, name: 'resume.docx' })).toThrow('DOCX')
    const external = docx({ '[Content_Types].xml': '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'word/document.xml': '<w:document xmlns:w="w"/>', 'word/_rels/document.xml.rels': '<Relationship Target="https://attacker.test" TargetMode="External"/>' })
    expect(() => validateResume({ data: external, mimetype: type, size: external.length, name: 'resume.docx' })).toThrow('DOCX')
  })
})

describe('applicant contact validation', () => {
  it('normalizes optional telephone and LinkedIn values and rejects unsafe input', () => {
    expect(normalizeApplicantTelephone(' +1 (416) 555-0198 ')).toBe('+1 (416) 555-0198')
    expect(normalizeApplicantTelephone('(416) 555-0199')).toBe('(416) 555-0199')
    expect(normalizeApplicantTelephone('')).toBeNull()
    expect(() => normalizeApplicantTelephone('555')).toThrow('Invalid telephone')
    expect(() => normalizeApplicantTelephone('416-555-0198 ext 4')).toThrow('Invalid telephone')
    expect(normalizeApplicantLinkedIn(' https://www.linkedin.com/in/synthetic-applicant#profile ')).toBe('https://www.linkedin.com/in/synthetic-applicant')
    expect(normalizeApplicantLinkedIn('https://ca.linkedin.com/in/synthetic-applicant')).toBe('https://ca.linkedin.com/in/synthetic-applicant')
    expect(normalizeApplicantLinkedIn(null)).toBeNull()
    expect(() => normalizeApplicantLinkedIn('http://www.linkedin.com/in/example')).toThrow('Invalid LinkedIn URL')
    expect(() => normalizeApplicantLinkedIn('https://linkedin.example/in/example')).toThrow('Invalid LinkedIn URL')
    expect(() => normalizeApplicantLinkedIn('https://user:secret@www.linkedin.com/in/example')).toThrow('Invalid LinkedIn URL')
    expect(() => normalizeApplicantLinkedIn('https://www.linkedin.com:444/in/example')).toThrow('Invalid LinkedIn URL')
  })

  it('keeps contact and other original intake fields immutable during hiring updates', () => {
    const original = { name: 'Applicant', email: 'applicant@example.test', telephone: '+1 416 555 0198', linkedIn: 'https://www.linkedin.com/in/applicant', coverLetter: 'Original', consent: true, jobId: 'job', resumeKey: 'resume', idempotencyKey: 'key', status: 'new' }
    expect(preserveApplicationIntake({ ...original, telephone: '+1 000 000 0000', linkedIn: null, status: 'interview' }, original)).toEqual({ ...original, status: 'interview' })
  })
})
