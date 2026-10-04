'use client'

import type { Page } from '@site-engine/contract'
import styles from './metadata-fields.module.css'

export type PageMetadataValue = Pick<
  Page,
  | 'kicker'
  | 'lede'
  | 'publishedAt'
  | 'lastReviewed'
  | 'businessCase'
  | 'jobPosting'
>

type Props = {
  template: Page['template']
  value: PageMetadataValue
  disabled?: boolean
  onChange: (value: PageMetadataValue) => void
}

const isoDate = (value?: string): string => value?.slice(0, 10) ?? ''
export const dateFromInput = (value: string): string | undefined =>
  value ? `${value}T00:00:00.000Z` : undefined

const emptyBusinessCase = (): NonNullable<Page['businessCase']> => ({
  client: 'Client name',
  industry: '',
  challenge: '',
  approach: '',
  outcome: '',
  services: [],
  publicationDate: new Date().toISOString(),
})

const emptyJobPosting = (): NonNullable<Page['jobPosting']> => ({
  datePosted: new Date().toISOString(),
  employmentType: 'FULL_TIME',
  location: { addressLocality: '', addressCountry: '' },
})

export function MetadataFields({ template, value, disabled = false, onChange }: Props) {
  const update = <Key extends keyof PageMetadataValue>(key: Key, next: PageMetadataValue[Key]) =>
    onChange({ ...value, [key]: next })

  return (
    <div className={styles.fields} data-page-editor-metadata>
      {template === 'service' ? (
        <fieldset disabled={disabled}>
          <legend>Service introduction</legend>
          <label>
            Kicker
            <input value={value.kicker ?? ''} maxLength={160} onChange={(event) => update('kicker', event.target.value || undefined)} />
          </label>
          <label>
            Lede
            <textarea value={value.lede ?? ''} maxLength={500} onChange={(event) => update('lede', event.target.value || undefined)} />
          </label>
        </fieldset>
      ) : null}

      {template === 'article' ? (
        <fieldset disabled={disabled}>
          <legend>Article dates</legend>
          <label>
            Published
            <input type="date" value={isoDate(value.publishedAt)} onChange={(event) => update('publishedAt', dateFromInput(event.target.value))} />
          </label>
        </fieldset>
      ) : null}

      {template === 'service' || template === 'article' ? (
        <label>
          Last reviewed
          <input disabled={disabled} type="date" value={isoDate(value.lastReviewed)} onChange={(event) => update('lastReviewed', dateFromInput(event.target.value))} />
        </label>
      ) : null}

      {template === 'article' ? (
        <BusinessCaseFields disabled={disabled} value={value.businessCase} onChange={(businessCase) => update('businessCase', businessCase)} />
      ) : null}

      {template === 'job' ? (
        <JobPostingFields disabled={disabled} value={value.jobPosting} onChange={(jobPosting) => update('jobPosting', jobPosting)} />
      ) : null}
    </div>
  )
}

function BusinessCaseFields({ value, disabled, onChange }: { value?: Page['businessCase']; disabled: boolean; onChange: (value?: Page['businessCase']) => void }) {
  if (!value) return <button type="button" disabled={disabled} onClick={() => onChange(emptyBusinessCase())}>Add business case details</button>
  const update = <Key extends keyof NonNullable<Page['businessCase']>>(key: Key, next: NonNullable<Page['businessCase']>[Key]) => onChange({ ...value, [key]: next })
  const identified = value.client !== undefined
  return (
    <fieldset disabled={disabled} data-page-editor-business-case>
      <legend>Business case</legend>
      <div className={styles.choice} role="group" aria-label="Client naming">
        <label><input type="radio" checked={identified} onChange={() => onChange({ ...value, client: value.client ?? '', anonymizedClient: undefined })} /> Named client</label>
        <label><input type="radio" checked={!identified} onChange={() => onChange({ ...value, client: undefined, anonymizedClient: value.anonymizedClient ?? '' })} /> Anonymized client</label>
      </div>
      <label>
        {identified ? 'Client' : 'Anonymized client'}
        <input maxLength={160} value={(identified ? value.client : value.anonymizedClient) ?? ''} onChange={(event) => identified ? update('client', event.target.value) : update('anonymizedClient', event.target.value)} />
      </label>
      <label>Industry<input maxLength={100} value={value.industry} onChange={(event) => update('industry', event.target.value)} /></label>
      <label>Challenge<textarea maxLength={2000} value={value.challenge} onChange={(event) => update('challenge', event.target.value)} /></label>
      <label>Approach<textarea maxLength={2000} value={value.approach} onChange={(event) => update('approach', event.target.value)} /></label>
      <label>Outcome<textarea maxLength={2000} value={value.outcome} onChange={(event) => update('outcome', event.target.value)} /></label>
      <label>
        Services <span className={styles.hint}>Separate names with commas.</span>
        <input value={value.services.join(', ')} onChange={(event) => update('services', event.target.value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 12))} />
      </label>
      <label>Case publication date<input type="date" value={isoDate(value.publicationDate)} onChange={(event) => update('publicationDate', dateFromInput(event.target.value) ?? '')} /></label>
      <button type="button" className={styles.remove} onClick={() => onChange(undefined)}>Remove business case details</button>
    </fieldset>
  )
}

function JobPostingFields({ value, disabled, onChange }: { value?: Page['jobPosting']; disabled: boolean; onChange: (value?: Page['jobPosting']) => void }) {
  if (!value) return <button type="button" disabled={disabled} onClick={() => onChange(emptyJobPosting())}>Add job posting details</button>
  const update = <Key extends keyof NonNullable<Page['jobPosting']>>(key: Key, next: NonNullable<Page['jobPosting']>[Key]) => onChange({ ...value, [key]: next })
  const location = value.location
  return (
    <fieldset disabled={disabled} data-page-editor-job-posting>
      <legend>Job posting</legend>
      <label>Date posted<input type="date" value={isoDate(value.datePosted)} onChange={(event) => update('datePosted', dateFromInput(event.target.value) ?? '')} /></label>
      <label>
        Employment type
        <select value={value.employmentType} onChange={(event) => update('employmentType', event.target.value as NonNullable<Page['jobPosting']>['employmentType'])}>
          <option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option><option value="CONTRACTOR">Contractor</option><option value="TEMPORARY">Temporary</option><option value="INTERN">Intern</option><option value="OTHER">Other</option>
        </select>
      </label>
      <label>City or locality<input maxLength={100} value={location.addressLocality} onChange={(event) => update('location', { ...location, addressLocality: event.target.value })} /></label>
      <label>Region<input maxLength={100} value={location.addressRegion ?? ''} onChange={(event) => update('location', { ...location, addressRegion: event.target.value || undefined })} /></label>
      <label>Country code <span className={styles.hint}>Two letters, such as CA.</span><input maxLength={2} pattern="[A-Z]{2}" value={location.addressCountry} onChange={(event) => update('location', { ...location, addressCountry: event.target.value.toUpperCase() })} /></label>
      <label>Closing date<input type="date" min={isoDate(value.datePosted)} value={isoDate(value.validThrough)} onChange={(event) => update('validThrough', dateFromInput(event.target.value))} /></label>
      <button type="button" className={styles.remove} onClick={() => onChange(undefined)}>Remove job posting details</button>
    </fieldset>
  )
}
